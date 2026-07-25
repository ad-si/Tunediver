(() => {
  // Copy-to-clipboard for the setup commands
  document.querySelectorAll(".code-block").forEach((block) => {
    const btn = block.querySelector(".copy-btn");
    const code = block.querySelector("code");
    if (!btn || !code) return;

    btn.addEventListener("click", async () => {
      const text = code.innerText.trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const range = document.createRange();
        range.selectNode(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("copy");
        sel.removeAllRanges();
      }
      const original = btn.textContent;
      btn.textContent = "OK";
      btn.classList.add("is-copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("is-copied");
      }, 1600);
    });
  });
})();
