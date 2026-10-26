// Masthead: go solid once scrolled past the top of the hero.
const masthead = document.querySelector('[data-masthead]');
const onScroll = () => masthead.classList.toggle('is-solid', window.scrollY > 40);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

// Mobile nav toggle.
const toggle = document.querySelector('[data-nav-toggle]');
const setOpen = (open) => {
  masthead.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', String(open));
};
toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
document.addEventListener('click', (e) => { if (!masthead.contains(e.target)) setOpen(false); });

// Event type filters.
const filters = document.querySelector('[data-filters]');
if (filters) {
  const cards = document.querySelectorAll('[data-event-list] .event');
  filters.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    filters.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    const type = btn.dataset.filter;
    cards.forEach((c) => { c.hidden = type !== 'all' && !c.classList.contains(`event--${type}`); });
  });
}

// Enquiry form: required fields (replaces the old validation.js).
document.querySelectorAll('[data-enquiry-form]').forEach((form) => {
  const error = form.querySelector('.form__error');
  form.addEventListener('submit', (e) => {
    let ok = true;
    form.querySelectorAll('[required]').forEach((f) => {
      const bad = !f.value.trim();
      f.setAttribute('aria-invalid', String(bad));
      if (bad) ok = false;
    });
    error.hidden = ok;
    if (!ok) {
      e.preventDefault();
      form.querySelector('[aria-invalid="true"]').focus();
    }
  });
});

// "Copy" button for the calendar web address.
document.querySelectorAll('[data-copy]').forEach((btn) => {
  const input = btn.parentElement.querySelector('[data-copy-source]');
  btn.addEventListener('click', async () => {
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      document.execCommand('copy');
    }
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2500);
  });
});

// Cookie consent: the choice is remembered in localStorage; optional third-party
// content (the Google map) only loads once the visitor accepts.
(() => {
  const KEY = 'bha_cookie_consent';
  const box = document.querySelector('[data-cookie-box]');
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage blocked */ } };

  function apply() {
    const granted = read() === 'granted';
    document.querySelectorAll('[data-consent-src]').forEach((frame) => {
      if (granted) frame.src = frame.dataset.consentSrc;
      else frame.removeAttribute('src');
      frame.hidden = !granted;
    });
    document.querySelectorAll('[data-consent-placeholder]').forEach((el) => { el.hidden = granted; });
  }

  function choose(value) {
    write(value);
    if (box) box.hidden = true;
    apply();
  }

  document.querySelectorAll('[data-consent-accept]').forEach((b) => b.addEventListener('click', () => choose('granted')));
  document.querySelectorAll('[data-consent-decline]').forEach((b) => b.addEventListener('click', () => choose('denied')));
  document.querySelectorAll('[data-consent-open]').forEach((b) => b.addEventListener('click', () => { if (box) box.hidden = false; }));

  apply();
  if (box && !read()) box.hidden = false;
})();
