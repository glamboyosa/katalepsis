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
