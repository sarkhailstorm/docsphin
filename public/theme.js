(function () {
  var KEY = 'docsphin:theme';
  // Saved under the app's earlier names, so a returning visitor keeps their choice.
  var LEGACY = ['free-secure-kit:theme', 'securekit:theme'];
  var choice = null;
  try {
    choice = localStorage.getItem(KEY);
    for (var i = 0; choice === null && i < LEGACY.length; i++) {
      choice = localStorage.getItem(LEGACY[i]);
      if (choice !== null) {
        localStorage.setItem(KEY, choice);
        localStorage.removeItem(LEGACY[i]);
      }
    }
  } catch (e) {}
  // Dark is the default; only an explicit choice of light opts out.
  if (choice !== 'light') document.documentElement.classList.add('dark');
})();
