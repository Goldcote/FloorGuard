// Runs before first paint (a classic script, loaded from the page's own origin so that a strict
// Content-Security-Policy needs no hash for it). Dark is the default for a first visit; a
// remembered choice wins.
try {
  var t = localStorage.getItem("floorguard.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
