/* ============================================================
   EXPENSIO marketing site — interactions
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Nav scrolled state ---------- */
  const nav = document.getElementById("nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 20);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- Mobile menu toggle ---------- */
  const navToggle = nav && nav.querySelector(".nav__toggle");
  if (navToggle) {
    const close = () => { nav.classList.remove("open"); navToggle.setAttribute("aria-expanded", "false"); };
    navToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = nav.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.querySelectorAll(".nav__links a").forEach((a) => a.addEventListener("click", close));
    document.addEventListener("click", (e) => { if (nav.classList.contains("open") && !nav.contains(e.target)) close(); });
    window.addEventListener("resize", () => { if (window.innerWidth > 980) close(); });
  }

  /* ---------- Reveal on scroll ---------- */
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  /* ---------- Parallax floating elements ---------- */
  const parallaxEls = Array.from(document.querySelectorAll("[data-parallax]"));
  let ticking = false;
  function applyParallax() {
    const vh = window.innerHeight;
    parallaxEls.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const delta = center - vh / 2;
      const speed = parseFloat(el.getAttribute("data-parallax")) || 0;
      el.style.transform = `translate3d(0, ${(-delta * speed).toFixed(1)}px, 0)`;
    });
    ticking = false;
  }
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    window.addEventListener(
      "scroll",
      () => {
        if (!ticking) {
          window.requestAnimationFrame(applyParallax);
          ticking = true;
        }
      },
      { passive: true }
    );
    applyParallax();
  }

  /* ---------- Animated counters ---------- */
  const fmt = (n, dec) =>
    n.toLocaleString("en-IN", {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    });
  const countIO = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el = e.target;
        const to = parseFloat(el.dataset.to);
        const dec = parseInt(el.dataset.decimals || "0", 10);
        const pre = el.dataset.prefix || "";
        const suf = el.dataset.suffix || "";
        const dur = 1700;
        let start = 0;
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min((now - t0) / dur, 1);
          const eased = 1 - Math.pow(1 - p, 3);
          const val = to * eased;
          let shown =
            to >= 1000 && dec === 0
              ? Math.round(val).toLocaleString("en-IN")
              : fmt(val, dec);
          el.textContent = pre + shown + suf;
          if (p < 1) requestAnimationFrame(step);
          else el.textContent = pre + (dec ? fmt(to, dec) : to.toLocaleString("en-IN")) + suf;
        };
        requestAnimationFrame(step);
        countIO.unobserve(el);
      });
    },
    { threshold: 0.5 }
  );
  document.querySelectorAll(".count").forEach((el) => countIO.observe(el));

  /* ---------- Showcase: 3D coverflow ---------- */
  const cover = document.querySelector(".cover");
  if (cover) {
    const slides = Array.from(cover.querySelectorAll(".cslide"));
    const n = slides.length;
    const capEl = document.getElementById("coverCap");
    const dotsWrap = document.querySelector(".cover__dots");
    let idx = 0, timer;

    slides.forEach((_, i) => {
      const b = document.createElement("button");
      b.setAttribute("aria-label", "Go to screen " + (i + 1));
      b.addEventListener("click", () => go(i, true));
      dotsWrap.appendChild(b);
    });
    const dots = Array.from(dotsWrap.children);

    function layout() {
      const w = window.innerWidth;
      const unit = w < 600 ? 122 : w < 980 ? 150 : 172;
      slides.forEach((s, i) => {
        let off = i - idx;
        if (off > n / 2) off -= n;
        if (off < -n / 2) off += n;
        const abs = Math.abs(off);
        if (abs > 2) {
          s.style.opacity = "0";
          s.style.transform = `translate(calc(-50% + ${(off > 0 ? 1 : -1) * 620}px), -50%) scale(.45)`;
          s.style.zIndex = "0";
          s.style.pointerEvents = "none";
          s.classList.remove("is-active");
          return;
        }
        const tx = off * unit;
        const tz = -abs * 135;
        const rot = -off * 27;
        const sc = 1 - abs * 0.16;
        s.style.transform = `translate(calc(-50% + ${tx}px), -50%) translateZ(${tz}px) rotateY(${rot}deg) scale(${sc})`;
        s.style.opacity = abs === 2 ? ".42" : "1";
        s.style.zIndex = String(10 - abs);
        s.style.pointerEvents = "auto";
        s.classList.toggle("is-active", off === 0);
      });
      if (capEl) {
        const txt = slides[idx].getAttribute("data-cap");
        if (capEl.innerHTML !== txt) {
          capEl.innerHTML = txt;
          capEl.classList.remove("swap");
          void capEl.offsetWidth;
          capEl.classList.add("swap");
        }
      }
      dots.forEach((d, i) => d.classList.toggle("on", i === idx));
    }
    function go(i, user) { idx = ((i % n) + n) % n; layout(); if (user) restart(); }
    function next() { go(idx + 1); }
    function restart() { clearInterval(timer); timer = setInterval(next, 3900); }

    cover.querySelector(".cover__nav--next").addEventListener("click", () => go(idx + 1, true));
    cover.querySelector(".cover__nav--prev").addEventListener("click", () => go(idx - 1, true));

    // click a side phone to bring it forward (ignore if it was a drag)
    let down = false, x0 = 0, moved = false;
    cover.addEventListener("pointerdown", (e) => { down = true; moved = false; x0 = e.clientX; });
    window.addEventListener("pointermove", (e) => { if (down && Math.abs(e.clientX - x0) > 8) moved = true; });
    window.addEventListener("pointerup", (e) => {
      if (!down) return;
      down = false;
      const dx = e.clientX - x0;
      if (Math.abs(dx) > 45) go(idx + (dx < 0 ? 1 : -1), true);
    });
    slides.forEach((s, i) => s.addEventListener("click", () => { if (!moved && i !== idx) go(i, true); }));

    // pause autoplay on hover
    cover.addEventListener("mouseenter", () => clearInterval(timer));
    cover.addEventListener("mouseleave", restart);
    window.addEventListener("resize", layout);

    layout();
    restart();
  }

  /* ---------- Architecture: Local / Cloud toggle ---------- */
  const arch = document.querySelector(".arch");
  if (arch) {
    const tabs = arch.querySelectorAll(".arch__tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const mode = tab.dataset.mode;
        arch.classList.toggle("is-cloud", mode === "cloud");
        tabs.forEach((t) => {
          const on = t === tab;
          t.classList.toggle("is-active", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        // restart the terminal log line-by-line reveal
        arch.querySelectorAll(".terminal__body p").forEach((p) => {
          p.style.animation = "none";
          void p.offsetWidth; // reflow
          p.style.animation = "";
        });
      });
    });
  }

  /* ---------- Feature, roadmap & testimonial cards: cursor-following spotlight ---------- */
  document.querySelectorAll(".fcard, .rcard, .tcard").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", ((e.clientX - r.left) / r.width) * 100 + "%");
      card.style.setProperty("--my", ((e.clientY - r.top) / r.height) * 100 + "%");
    });
  });

  /* ---------- Custom animated cursor ---------- */
  const fine = window.matchMedia("(pointer:fine)").matches;
  const noMotion = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
  if (fine && !noMotion) {
    const core = document.createElement("div");
    const ret = document.createElement("div");
    core.className = "cur-core";
    ret.className = "cur-reticle";
    ret.innerHTML = '<span class="cur-ring"></span>';
    document.body.append(core, ret);
    document.documentElement.classList.add("cc-on");

    // center dot tracks exactly; reticle frame trails smoothly
    let tx = window.innerWidth / 2, ty = window.innerHeight / 2, rx = tx, ry = ty;
    window.addEventListener("mousemove", (e) => {
      tx = e.clientX; ty = e.clientY;
      core.style.transform = `translate(${tx}px, ${ty}px) translate(-50%, -50%)`;
    });
    (function raf() {
      rx += (tx - rx) * 0.22;
      ry += (ty - ry) * 0.22;
      ret.style.transform = `translate(${rx}px, ${ry}px) translate(-50%, -50%)`;
      requestAnimationFrame(raf);
    })();

    const hoverSel = "a,button,summary,.cslide,.fcard,.rcard,.tcard,.acc__item,.arch__tab,.cover__nav,.stat,.fab,.brand,.pill";
    const setHover = (on) => { ret.classList.toggle("is-hover", on); core.classList.toggle("is-hover", on); };
    document.addEventListener("mouseover", (e) => { if (e.target.closest && e.target.closest(hoverSel)) setHover(true); });
    document.addEventListener("mouseout", (e) => {
      const to = e.relatedTarget;
      if (e.target.closest && e.target.closest(hoverSel) && !(to && to.closest && to.closest(hoverSel))) setHover(false);
    });
    window.addEventListener("mousedown", () => ret.classList.add("is-down"));
    window.addEventListener("mouseup", () => ret.classList.remove("is-down"));
    document.addEventListener("mouseleave", () => { core.style.opacity = "0"; ret.style.opacity = "0"; });
    document.addEventListener("mouseenter", () => { core.style.opacity = ""; ret.style.opacity = ""; });
  }

  /* ---------- iOS "coming soon" toast ---------- */
  const soonBtns = document.querySelectorAll("[data-coming-soon]");
  if (soonBtns.length) {
    let toast, hideTimer;
    const showToast = () => {
      if (!toast) {
        toast = document.createElement("div");
        toast.className = "toast";
        toast.setAttribute("role", "status");
        toast.innerHTML =
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
          '<path d="M17.05 12.53c-.02-2.4 1.96-3.55 2.05-3.61-1.12-1.63-2.86-1.86-3.48-1.88-1.48-.15-2.89.87-3.64.87-.75 0-1.91-.85-3.14-.83-1.61.02-3.1.94-3.93 2.38-1.68 2.91-.43 7.22 1.2 9.58.8 1.16 1.75 2.46 3 2.41 1.2-.05 1.66-.78 3.11-.78 1.45 0 1.86.78 3.13.75 1.29-.02 2.11-1.18 2.9-2.34.91-1.34 1.29-2.64 1.31-2.71-.03-.01-2.51-.96-2.53-3.84Z"/>' +
          '<path d="M14.9 5.36c.66-.8 1.11-1.91.99-3.02-.95.04-2.11.63-2.79 1.43-.61.71-1.15 1.85-1.01 2.94 1.07.08 2.15-.54 2.81-1.35Z"/></svg>' +
          '<span><strong>Coming in September.</strong> Expensio for iPhone is finished and heading to the App Store.</span>';
        document.body.appendChild(toast);
      }
      requestAnimationFrame(() => toast.classList.add("is-on"));
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => toast.classList.remove("is-on"), 4600);
    };
    soonBtns.forEach((b) => b.addEventListener("click", showToast));
  }

  /* ---------- FAQ: single-open accordion ---------- */
  const items = document.querySelectorAll(".acc__item");
  items.forEach((it) => {
    it.addEventListener("toggle", () => {
      if (it.open) items.forEach((o) => { if (o !== it) o.open = false; });
    });
  });
})();
