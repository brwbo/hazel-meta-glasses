import numpy as np

SR = 16000
HOP = 512
SPEECH_P = 0.5
MIN_SPEECH_FRAC = 0.35
_vad = None


def _load_vad():
    global _vad
    if _vad is None:
        import torch
        from silero_vad import load_silero_vad

        torch.set_num_threads(1)
        _vad = load_silero_vad()
    return _vad


def speech_probs(audio):
    import torch

    vad = _load_vad()
    vad.reset_states()
    n = len(audio) // HOP
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    x = torch.from_numpy(np.ascontiguousarray(audio[: n * HOP], dtype=np.float32)).reshape(n, HOP)
    out = np.empty(n, dtype=np.float32)
    with torch.no_grad():
        for i in range(n):
            out[i] = float(vad(x[i], SR).item())
    return out


def _spectra(audio, win=512, hop=256):
    n = (len(audio) - win) // hop + 1
    if n < 8:
        return None, None
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    frames = audio[idx] * np.hanning(win)[None, :]
    mag = np.abs(np.fft.rfft(frames, axis=1))
    return mag, np.fft.rfftfreq(win, 1 / SR)


def band_ratio(audio):
    mag, freqs = _spectra(audio)
    if mag is None:
        return 1.0
    p = (mag**2).sum(axis=0)
    band = p[(freqs >= 300) & (freqs <= 3400)].sum()
    return float(band / (p.sum() + 1e-12))


def sustained_tone(audio):
    mag, freqs = _spectra(audio, win=1024, hop=512)
    if mag is None:
        return 0.0
    lo = (freqs >= 80) & (freqs <= 2000)
    energy = mag.sum(axis=1)
    peak = freqs[lo][np.argmax(mag[:, lo], axis=1)]
    active = energy > 0.1 * np.median(energy + 1e-9)
    stable = np.zeros(len(peak), dtype=bool)
    for i in range(1, len(peak)):
        stable[i] = active[i] and active[i - 1] and abs(peak[i] - peak[i - 1]) < 0.03 * peak[i - 1]
    run = best = 0
    count = 0
    for s in stable:
        run = run + 1 if s else 0
        if run >= 8:
            count += 1
    return float(count / len(stable))


def beat_regularity(audio):
    mag, _ = _spectra(audio, win=512, hop=256)
    if mag is None:
        return 0.0
    flux = np.maximum(np.diff(np.log1p(mag), axis=0), 0).sum(axis=1)
    flux = flux - flux.mean()
    if flux.std() < 1e-6:
        return 0.0
    ac = np.correlate(flux, flux, mode="full")[len(flux) - 1 :]
    ac = ac / (ac[0] + 1e-12)
    lo, hi = int(0.3 * SR / 256), min(int(1.0 * SR / 256), len(ac) - 1)
    if hi <= lo:
        return 0.0
    return float(max(ac[lo:hi].max(), 0.0))


def analyse(audio):
    probs = speech_probs(audio)
    return {
        "probs": probs,
        "speech_frac": float((probs > SPEECH_P).mean()) if len(probs) else 0.0,
        "band": band_ratio(audio),
        "tone": sustained_tone(audio),
        "beat": beat_regularity(audio),
    }


LIP_OFF = 0.15
LIP_ON = 0.5
SILENCE_RMS = 0.01


def _energy_ok(audio):
    n = len(audio) // 320
    if n == 0:
        return False
    frames = audio[: n * 320].reshape(n, 320)
    rms = np.sqrt((frames.astype(np.float32) ** 2).mean(axis=1))
    return float((rms > SILENCE_RMS).mean()) >= 0.03


def music_score(info):
    score = 0.0
    if info["tone"] >= 0.15:
        score += 1.0
    if info["beat"] >= 0.3:
        score += 1.0
    if score and info["band"] < 0.25:
        score += 0.5
    return score


def gate(audio, lip=None):
    if lip is not None and lip < LIP_OFF:
        return None
    audio = np.asarray(audio, dtype=np.float32)
    if len(audio) < SR // 4 or not _energy_ok(audio):
        return None
    lenient = lip is not None and lip >= LIP_ON
    try:
        info = analyse(audio)
    except Exception:
        return audio
    if info["speech_frac"] < (MIN_SPEECH_FRAC - (0.1 if lenient else 0.0)):
        return None
    if music_score(info) >= (2.0 if lenient else 1.0):
        return None
    mask = info["probs"] > (0.35 if lenient else SPEECH_P)
    mask = np.convolve(mask.astype(np.float32), np.ones(7), mode="same") > 0
    keep = np.zeros(len(audio), dtype=bool)
    for i in np.flatnonzero(mask):
        keep[i * HOP : (i + 1) * HOP] = True
    return np.where(keep, audio, 0.0).astype(np.float32)
