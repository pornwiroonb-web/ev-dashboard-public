// Admin-only page guard. Include this on any page that is NOT meant for the
// contractor (ผรม.) portal. Not authenticated -> back to the login page.
// Authenticated as a contractor -> sent to /contractor.html instead.
(async function () {
  try {
    const res = await fetch("/api/auth/status");
    const data = await res.json();
    if (!data.authenticated) {
      window.location.replace("/");
      return;
    }
    if (data.role === "contractor") {
      window.location.replace("/contractor.html");
      return;
    }
    if (data.role === "client") {
      window.location.replace("/client.html");
    }
  } catch (e) {
    window.location.replace("/");
  }
})();
