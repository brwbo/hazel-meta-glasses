import json
import re
import sqlite3
import threading
import time

import numpy as np


class ConsentRequired(Exception):
    pass


PROFILE_COLUMNS = {
    "role": "TEXT NOT NULL DEFAULT ''",
    "tags": "TEXT NOT NULL DEFAULT '[]'",
    "followups": "TEXT NOT NULL DEFAULT '[]'",
    "summary": "TEXT NOT NULL DEFAULT ''",
    "thumb": "BLOB",
    "model_path": "TEXT",
    "last_seen": "REAL",
    "auto": "INTEGER NOT NULL DEFAULT 0",
    "name_source": "TEXT NOT NULL DEFAULT 'manual'",
    "manual_fields": "TEXT NOT NULL DEFAULT '[]'",
    "pinned_thumb": "BLOB",
    "thumb_clear": "INTEGER NOT NULL DEFAULT 0",
}


def _json_list(raw):
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [str(v) for v in value] if isinstance(value, list) else []


def _clean_list(values, limit=20, length=200):
    out = []
    for v in values or []:
        s = str(v).strip()[:length]
        if s and s not in out:
            out.append(s)
    return out[:limit]


class Store:
    def __init__(self, path="memory.db", seen_interval=5.0):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA foreign_keys = ON")
        self.seen_interval = seen_interval
        self._seen_written = {}
        self._seen = {}
        self._snap_ts = {}
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS people (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                consent_at REAL NOT NULL,
                consent_note TEXT NOT NULL,
                embedding BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY,
                person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
                ts REAL NOT NULL,
                text TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY,
                person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
                ts REAL NOT NULL,
                score REAL NOT NULL,
                clear INTEGER NOT NULL DEFAULT 0,
                jpeg BLOB NOT NULL
            );
            """
        )
        self._migrate()

    def _migrate(self):
        with self.lock:
            have = {r[1] for r in self.db.execute("PRAGMA table_info(people)")}
            for col, decl in PROFILE_COLUMNS.items():
                if col not in have:
                    self.db.execute(f"ALTER TABLE people ADD COLUMN {col} {decl}")
            if "clear" not in {r[1] for r in self.db.execute("PRAGMA table_info(snapshots)")}:
                self.db.execute("ALTER TABLE snapshots ADD COLUMN clear INTEGER NOT NULL DEFAULT 0")
            self.db.commit()

    def enrol(self, name, embedding, consent_note, role="", thumb=None, auto=False, name_source="manual",
              thumb_score=0.0, thumb_clear=False):
        if not consent_note or not consent_note.strip():
            raise ConsentRequired("a consent note is required to enrol anyone")
        if not name or not name.strip():
            raise ValueError("a name is required")
        vec = np.asarray(embedding, dtype=np.float32).ravel()
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO people (name, consent_at, consent_note, embedding, role, thumb, auto, name_source) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (name.strip(), time.time(), consent_note.strip(), vec.tobytes(), (role or "").strip(), thumb,
                 1 if auto else 0, name_source),
            )
            self.db.commit()
            if thumb:
                self.add_snapshot(cur.lastrowid, thumb, thumb_score, clear=thumb_clear)
            return cur.lastrowid

    def people(self):
        with self.lock:
            rows = self.db.execute("SELECT id, name, embedding FROM people").fetchall()
        return [(i, n, np.frombuffer(b, dtype=np.float32)) for i, n, b in rows]

    def match(self, embedding, threshold=0.363):
        vec = np.asarray(embedding, dtype=np.float32).ravel()
        best = None
        for pid, name, known in self.people():
            if known.shape != vec.shape:
                continue
            denom = np.linalg.norm(vec) * np.linalg.norm(known)
            if denom == 0:
                continue
            score = float(np.dot(vec, known) / denom)
            if score >= threshold and (best is None or score > best[2]):
                best = (pid, name, score)
        return best

    def exists(self, person_id):
        with self.lock:
            return self.db.execute("SELECT 1 FROM people WHERE id = ?", (person_id,)).fetchone() is not None

    def add_note(self, person_id, text, ts=None):
        ts = time.time() if ts is None else ts
        with self.lock:
            self.db.execute(
                "INSERT INTO notes (person_id, ts, text) VALUES (?, ?, ?)",
                (person_id, ts, text),
            )
            self.db.commit()
        return ts

    def notes_with_ids(self, person_id):
        with self.lock:
            return self.db.execute(
                "SELECT id, ts, text FROM notes WHERE person_id = ? ORDER BY ts, id", (person_id,)
            ).fetchall()

    def delete_note(self, person_id, note_id):
        with self.lock:
            cur = self.db.execute("DELETE FROM notes WHERE person_id = ? AND id = ?", (person_id, note_id))
            self.db.commit()
            return cur.rowcount > 0

    def notes(self, person_id):
        with self.lock:
            return self.db.execute(
                "SELECT ts, text FROM notes WHERE person_id = ? ORDER BY ts, id", (person_id,)
            ).fetchall()

    def _profile(self, row):
        pid, name, role, tags, followups, summary, has_thumb, model_path, last_seen, consent_at, consent_note, auto, name_source, manual, pinned, thumb_clear = row
        seen = max(filter(None, [last_seen, self._seen.get(pid)]), default=None)
        return {
            "id": pid,
            "name": name,
            "role": role or "",
            "tags": _json_list(tags),
            "followups": _json_list(followups),
            "summary": summary or "",
            "hasThumb": bool(has_thumb),
            "modelPath": model_path,
            "lastSeen": seen,
            "consentAt": consent_at,
            "consentNote": consent_note,
            "auto": bool(auto),
            "nameSource": name_source,
            "manualFields": _json_list(manual),
            "pinned": bool(pinned),
            "thumbClear": bool(thumb_clear),
        }

    _SELECT = (
        "SELECT id, name, role, tags, followups, summary, thumb IS NOT NULL, model_path, last_seen, consent_at, consent_note, auto, name_source, "
        "manual_fields, pinned_thumb IS NOT NULL, thumb_clear "
        "FROM people"
    )

    def list_people(self):
        with self.lock:
            rows = self.db.execute(self._SELECT + " ORDER BY id").fetchall()
            return [self._profile(r) for r in rows]

    def get_person(self, person_id):
        with self.lock:
            row = self.db.execute(self._SELECT + " WHERE id = ?", (person_id,)).fetchone()
            return None if row is None else self._profile(row)

    def update_profile(self, person_id, summary=None, tags=None, followups=None, role=None, manual=False):
        with self.lock:
            current = self.get_person(person_id)
            if current is None:
                return
            locked = set(current["manualFields"])
            sets, args = [], []
            for field, value in (("summary", summary), ("role", role)):
                if value is None or (field in locked and not manual):
                    continue
                sets.append(f"{field} = ?")
                args.append(str(value).strip()[:2000 if field == "summary" else 120])
                if manual:
                    locked.add(field)
            for field, value, limit, length in (("tags", tags, 12, 40), ("followups", followups, 12, 300)):
                if value is None:
                    continue
                items = list(value)
                if field in locked and not manual:
                    items = current[field] + items
                sets.append(f"{field} = ?")
                args.append(json.dumps(_clean_list(items, limit, length)))
                if manual:
                    locked.add(field)
            if not sets:
                return
            sets.append("manual_fields = ?")
            args.append(json.dumps(sorted(locked)))
            self.db.execute(f"UPDATE people SET {', '.join(sets)} WHERE id = ?", (*args, person_id))
            self.db.commit()

    def rename(self, person_id, name=None, role=None, source="manual"):
        sets, args = [], []
        if name is not None:
            if not str(name).strip():
                raise ValueError("name cannot be empty")
            sets.append("name = ?, name_source = ?")
            args.extend([str(name).strip()[:80], source])
        if role is not None:
            sets.append("role = ?")
            args.append(str(role).strip()[:120])
        if sets:
            with self.lock:
                self.db.execute(f"UPDATE people SET {', '.join(sets)} WHERE id = ?", (*args, person_id))
                self.db.commit()

    def name_from_speech(self, person_id, candidates, min_conf=0.7):
        person = self.get_person(person_id)
        if person is None or person["nameSource"] != "placeholder" or not re.fullmatch(r"Guest \d+", person["name"]):
            return None
        good = [c for c in candidates or [] if isinstance(c, dict) and isinstance(c.get("name"), str)
                and c["name"].strip() and isinstance(c.get("confidence"), (int, float))]
        if not good:
            return None
        best = max(good, key=lambda c: c["confidence"])
        if best["confidence"] < min_conf:
            return None
        name = best["name"].strip()[:80]
        self.rename(person_id, name=name, source="audio")
        quote = str(best.get("quote") or "").strip()[:300]
        self.add_note(person_id, f"named from speech: '{quote}'")
        return name

    def embedding(self, person_id):
        with self.lock:
            row = self.db.execute("SELECT embedding FROM people WHERE id = ?", (person_id,)).fetchone()
        return None if row is None else np.frombuffer(row[0], dtype=np.float32)

    def thumb_state(self, person_id):
        with self.lock:
            row = self.db.execute("SELECT MAX(score), MAX(clear) FROM snapshots WHERE person_id = ?",
                                  (person_id,)).fetchone()
        return (row[0] or 0.0, bool(row[1]), self._snap_ts.get(person_id, -1e18))

    def add_snapshot(self, person_id, jpeg, score, ts=None, keep=3, clear=False):
        ts = time.time() if ts is None else ts
        order = "ORDER BY clear DESC, score DESC, id DESC"
        with self.lock:
            self._snap_ts[person_id] = ts
            self.db.execute("INSERT INTO snapshots (person_id, ts, score, clear, jpeg) VALUES (?, ?, ?, ?, ?)",
                            (person_id, ts, float(score), 1 if clear else 0, jpeg))
            self.db.execute(f"DELETE FROM snapshots WHERE person_id = ? AND id NOT IN (SELECT id FROM snapshots "
                            f"WHERE person_id = ? {order} LIMIT ?)", (person_id, person_id, keep))
            best = self.db.execute(f"SELECT jpeg FROM snapshots WHERE person_id = ? {order} LIMIT 1",
                                   (person_id,)).fetchone()
            self.db.execute("UPDATE people SET thumb = ?, thumb_clear = MAX(thumb_clear, ?) WHERE id = ?",
                            (best[0], 1 if clear else 0, person_id))
            self.db.commit()

    def snapshots(self, person_id):
        with self.lock:
            return self.db.execute("SELECT id, score, ts FROM snapshots WHERE person_id = ? ORDER BY clear DESC, "
                                   "score DESC, id DESC", (person_id,)).fetchall()

    def snapshot(self, person_id, snap_id):
        with self.lock:
            row = self.db.execute("SELECT jpeg FROM snapshots WHERE person_id = ? AND id = ?",
                                  (person_id, snap_id)).fetchone()
        return None if row is None else row[0]

    def count_auto(self):
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM people WHERE auto = 1").fetchone()[0]

    def delete_auto(self):
        with self.lock:
            ids = [r[0] for r in self.db.execute("SELECT id FROM people WHERE auto = 1")]
            return [(pid, self.delete_person(pid)) for pid in ids]

    def thumb(self, person_id):
        with self.lock:
            row = self.db.execute("SELECT pinned_thumb, thumb FROM people WHERE id = ?", (person_id,)).fetchone()
        return None if row is None else (row[0] or row[1])

    def set_pinned(self, person_id, jpeg):
        with self.lock:
            self.db.execute("UPDATE people SET pinned_thumb = ? WHERE id = ?", (jpeg, person_id))
            self.db.commit()

    def set_thumb(self, person_id, jpeg):
        with self.lock:
            self.db.execute("UPDATE people SET thumb = ? WHERE id = ?", (jpeg, person_id))
            self.db.commit()

    def set_embedding(self, person_id, embedding):
        vec = np.asarray(embedding, dtype=np.float32).ravel()
        with self.lock:
            self.db.execute("UPDATE people SET embedding = ? WHERE id = ?", (vec.tobytes(), person_id))
            self.db.commit()

    def set_model_path(self, person_id, path):
        with self.lock:
            self.db.execute("UPDATE people SET model_path = ? WHERE id = ?", (path, person_id))
            self.db.commit()

    def seen(self, person_id, ts=None):
        ts = time.time() if ts is None else ts
        with self.lock:
            self._seen[person_id] = ts
            if ts - self._seen_written.get(person_id, 0) < self.seen_interval:
                return
            self._seen_written[person_id] = ts
            self.db.execute("UPDATE people SET last_seen = ? WHERE id = ?", (ts, person_id))
            self.db.commit()

    def delete_person(self, person_id):
        with self.lock:
            row = self.db.execute("SELECT model_path FROM people WHERE id = ?", (person_id,)).fetchone()
            self.db.execute("DELETE FROM notes WHERE person_id = ?", (person_id,))
            self.db.execute("DELETE FROM snapshots WHERE person_id = ?", (person_id,))
            self.db.execute("DELETE FROM people WHERE id = ?", (person_id,))
            self.db.commit()
            self._seen.pop(person_id, None)
            self._seen_written.pop(person_id, None)
            self._snap_ts.pop(person_id, None)
        return None if row is None else (row[0] or "")
