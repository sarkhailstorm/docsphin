(function () {
  // Chrome offers the install once per page load, often before React has
  // mounted the button, so the offer is kept here for the button to pick up.
  function set(event) {
    window.__installPrompt = event;
    window.dispatchEvent(new Event('installpromptchange'));
  }
  window.addEventListener('beforeinstallprompt', function (event) {
    // Stops Chrome's own strip so our button is the only ask
    event.preventDefault();
    set(event);
  });
  window.addEventListener('appinstalled', function () {
    set(null);
  });
})();
