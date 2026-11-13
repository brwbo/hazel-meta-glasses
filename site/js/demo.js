export function initDemo(src) {
  const box = document.getElementById("demo-frame");
  const restart = document.getElementById("demo-restart");
  const status = document.getElementById("demo-status");
  let iframe = null;
  let paused = true;
  let held = [];
  let release = null;

  function hook() {
    held = [];
    release = null;
    try {
      const win = iframe.contentWindow;
      const real = win.requestAnimationFrame.bind(win);
      win.requestAnimationFrame = (cb) => {
        if (paused) {
          held.push(cb);
          return 0;
        }
        return real(cb);
      };
      release = () => held.splice(0).forEach((cb) => real(cb));
    } catch (err) {
      release = null;
    }
  }

  function setPaused(next) {
    paused = next;
    box.dataset.paused = String(next);
    if (!next && release) release();
  }

  function mount() {
    if (iframe) return;
    iframe = document.createElement("iframe");
    iframe.className = "demo-live";
    iframe.title = "Hazel live demo with simulated people";
    iframe.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
    iframe.addEventListener("load", () => {
      hook();
      box.dataset.state = "live";
      status.textContent = "Demo running";
      restart.disabled = false;
      if (!paused && release) release();
    });
    box.dataset.state = "loading";
    iframe.src = src;
    box.append(iframe);
  }

  restart.addEventListener("click", () => {
    if (!iframe) return mount();
    restart.disabled = true;
    box.dataset.state = "loading";
    status.textContent = "Restarting the demo";
    try {
      iframe.contentWindow.location.reload();
    } catch (err) {
      iframe.src = src;
    }
  });

  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) mount();
  }, { rootMargin: "700px 0px" }).observe(box);
  new IntersectionObserver(([entry]) => setPaused(!entry.isIntersecting), { threshold: 0.05 }).observe(box);

  return { paused: () => paused, mounted: () => !!iframe, frame: () => iframe };
}
