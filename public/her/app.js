const SESSION_KEY = "her_authed_v1";

function authed() {
  return !!sessionStorage.getItem(SESSION_KEY);
}

function goHome() {
  location.replace("/");
}

if (!authed()) goHome();

const monthsView = document.getElementById("monthsView");
const monthView = document.getElementById("monthView");
const photosEl = document.getElementById("photos");
const monthLabelEl = document.getElementById("monthLabel");
const monthCountEl = document.getElementById("monthCount");
const backBtn = document.getElementById("backBtn");
const homeBtn = document.getElementById("homeBtn");
const topTitle = document.getElementById("topTitle");

const lightbox = document.getElementById("lightbox");
const lbImg = document.getElementById("lbImg");
const lbClose = document.getElementById("lbClose");
const lbPrev = document.getElementById("lbPrev");
const lbNext = document.getElementById("lbNext");

let currentMonth = null;
let lbIndex = 0;

homeBtn.addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  goHome();
});

backBtn.addEventListener("click", () => {
  showMonths();
});

function showMonths() {
  monthView.hidden = true;
  monthsView.hidden = false;
  backBtn.hidden = true;
  topTitle.textContent = "Months";
  photosEl.innerHTML = "";
  currentMonth = null;
}

function showMonth(monthObj) {
  monthsView.hidden = true;
  monthView.hidden = false;
  backBtn.hidden = false;
  topTitle.textContent = monthObj.label;

  monthLabelEl.textContent = monthObj.label;
  monthCountEl.textContent = `${monthObj.images.length} note${monthObj.images.length === 1 ? "" : "s"}`;

  currentMonth = monthObj;
  renderPhotos(monthObj);
}

async function loadMonths() {
  const res = await fetch("./months.json", { cache: "no-store" });
  if (!res.ok) goHome();
  const data = await res.json();

  const months = (data.months || [])
    .slice()
    .sort((a, b) => (a.id > b.id ? 1 : -1));

  monthsView.innerHTML = "";

  for (const m of months) {
    const tile = document.createElement("div");
    tile.className = "month-tile";
    tile.tabIndex = 0;

    const name = document.createElement("div");
    name.className = "month-name";
    name.textContent = m.label;

    const meta = document.createElement("div");
    meta.className = "month-meta";
    meta.textContent = `${(m.images || []).length} note${(m.images || []).length === 1 ? "" : "s"}`;

    tile.appendChild(name);
    tile.appendChild(meta);

    tile.addEventListener("click", () => showMonth(m));
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") showMonth(m);
    });

    monthsView.appendChild(tile);
  }
}

function renderPhotos(monthObj) {
  photosEl.innerHTML = "";

  const images = (monthObj.images || []).slice();

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;

      const img = entry.target.querySelector("img[data-src]");
      if (img) {
        img.src = img.dataset.src;
        img.removeAttribute("data-src");
        img.addEventListener("load", () => {
          const sk = entry.target.querySelector(".skeleton");
          if (sk) sk.remove();
        }, { once: true });
      }
      observer.unobserve(entry.target);
    }
  }, {
    root: null,
    rootMargin: "700px 0px",
    threshold: 0.01
  });

  images.forEach((filename, idx) => {
    const card = document.createElement("div");
    card.className = "photo-card";

    const sk = document.createElement("div");
    sk.className = "skeleton";
    card.appendChild(sk);

    const img = document.createElement("img");
    img.className = "photo";
    img.alt = `${monthObj.label} note ${idx + 1}`;
    img.decoding = "async";
    img.loading = "lazy";

    img.dataset.src = `${monthObj.path}${filename}`;

    card.appendChild(img);
    card.addEventListener("click", () => openLightbox(idx));
    photosEl.appendChild(card);
    observer.observe(card);
  });
}

/* ---------- Lightbox ---------- */

function openLightbox(idx) {
  if (!currentMonth) return;
  lbIndex = idx;
  setLightboxImage();
  lightbox.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  lightbox.hidden = true;
  lbImg.src = "";
  document.body.style.overflow = "";
}

function setLightboxImage() {
  if (!currentMonth) return;
  const images = currentMonth.images || [];
  if (!images.length) return;
  const filename = images[lbIndex];
  lbImg.src = `${currentMonth.path}${filename}`;
  lbImg.alt = `${currentMonth.label} note ${lbIndex + 1}`;
}

function lbStep(delta) {
  if (!currentMonth) return;
  const n = (currentMonth.images || []).length;
  if (!n) return;
  lbIndex = (lbIndex + delta + n) % n;
  setLightboxImage();
}

lbClose.addEventListener("click", closeLightbox);
lbPrev.addEventListener("click", (e) => { e.stopPropagation(); lbStep(-1); });
lbNext.addEventListener("click", (e) => { e.stopPropagation(); lbStep(1); });

lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox || e.target === lbImg) closeLightbox();
});

document.addEventListener("keydown", (e) => {
  if (lightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") lbStep(-1);
  else if (e.key === "ArrowRight") lbStep(1);
});

// Touch: swipe left/right to navigate, swipe down to close.
let touchStartX = 0;
let touchStartY = 0;
let touchActive = false;

lightbox.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchActive = true;
}, { passive: true });

lightbox.addEventListener("touchend", (e) => {
  if (!touchActive) return;
  touchActive = false;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (absX > 50 && absX > absY) {
    lbStep(dx < 0 ? 1 : -1);
  } else if (dy > 80 && absY > absX) {
    closeLightbox();
  }
}, { passive: true });

loadMonths().catch(goHome);
