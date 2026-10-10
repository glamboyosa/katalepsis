// Copy buttons for commands.
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy");
    const label = button.querySelector("b");
    if (text === null || label === null) return;
    try {
      await navigator.clipboard.writeText(text);
      label.textContent = "copied";
    } catch {
      label.textContent = "select it";
    }
    window.setTimeout(() => {
      label.textContent = "copy";
    }, 1500);
  });
}

// Hovering or tapping a status chip runs its check again: back to RUNNING, then the result.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
for (const chip of document.querySelectorAll(".chip")) {
  const rerun = () => {
    if (reducedMotion.matches || chip.dataset.running === "true") return;
    chip.dataset.running = "true";
    chip.style.setProperty("--resolve", "650ms");
    for (const label of chip.querySelectorAll(".state b")) {
      // Clearing and restoring the animation restarts it from the first frame.
      label.style.animation = "none";
      void label.offsetWidth;
      label.style.animation = "";
    }
    window.setTimeout(() => {
      delete chip.dataset.running;
    }, 1000);
  };
  chip.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") rerun();
  });
  chip.addEventListener("click", rerun);
}

// Video playback speed toggle.
const video = document.querySelector("[data-video]");
const speed = document.querySelector("[data-speed]");
if (video && speed) {
  speed.addEventListener("click", () => {
    video.playbackRate = video.playbackRate === 1 ? 2 : 1;
  });
  video.addEventListener("ratechange", () => {
    const rate = video.playbackRate;
    speed.textContent = `${rate}×`;
    speed.setAttribute("aria-label", `Playback speed ${rate}×. Switch to ${rate === 1 ? "2×" : "1×"}`);
  });
}

// Pause the sprite while the tab is hidden.
const sprites = document.querySelectorAll(".mark img");
document.addEventListener("visibilitychange", () => {
  for (const sprite of sprites) sprite.style.animationPlayState = document.hidden ? "paused" : "running";
});
