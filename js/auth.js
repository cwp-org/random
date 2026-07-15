/* Client-side access gate for the Depth Review & Adjustment Dashboard.
 *
 * SECURITY NOTE: this is a lightweight access gate for a static GitHub Pages
 * website, validated entirely in the browser. It is NOT equivalent to
 * server-side authentication: the site's files (including the data files)
 * are still publicly reachable by anyone who knows their URLs, and a
 * determined visitor can bypass the gate. It deters casual access only.
 * Do not rely on it to protect sensitive data.
 *
 * Only a SHA-256 hash of the password is stored below (no plain text).
 * Authenticated state lives in sessionStorage, so it survives reloads in
 * the same tab but expires when the browser session ends.
 *
 * The dashboard itself (js/app.js) exposes its entry point as
 * window.__startDashboard instead of self-starting; this gate calls it
 * after successful authentication, so no dashboard data is fetched or
 * processed before login.
 */

"use strict";

(function () {
  // SHA-256 hex digest of the access password.
  const PASSWORD_SHA256 =
    "0291d13f39380852dbd62f5ca6951d64b3190c10a43bd5503e449720c6439358";
  const SESSION_KEY = "depth-dashboard:auth:v1";

  const $ = (id) => document.getElementById(id);
  let started = false;

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function unlock() {
    $("login-screen").hidden = true;
    for (const el of document.querySelectorAll("[data-requires-auth]")) {
      el.hidden = false;
    }
    if (!started && typeof window.__startDashboard === "function") {
      started = true;
      window.__startDashboard();
    }
  }

  function lock() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    // Full reload drops all in-memory dashboard data and shows the gate.
    window.location.reload();
  }

  function showError(msg) {
    const err = $("login-error");
    err.textContent = msg;
    err.hidden = false;
  }

  async function onSubmit(event) {
    event.preventDefault();
    const input = $("login-password");
    const value = input.value;
    if (!value) { showError("Please enter the access password."); return; }
    let hash;
    try {
      hash = await sha256Hex(value);
    } catch {
      showError("Password check unavailable — this page must be served over HTTPS (or localhost).");
      return;
    }
    if (hash === PASSWORD_SHA256) {
      try { sessionStorage.setItem(SESSION_KEY, PASSWORD_SHA256); } catch { /* ignore */ }
      $("login-error").hidden = true;
      unlock();
    } else {
      input.value = "";
      input.focus();
      showError("Incorrect password. Please try again.");
    }
  }

  function initGate() {
    // <form> submit covers both the button click and the Enter key.
    $("login-form").addEventListener("submit", onSubmit);
    $("btn-logout").addEventListener("click", lock);

    let stored = null;
    try { stored = sessionStorage.getItem(SESSION_KEY); } catch { /* ignore */ }
    if (stored === PASSWORD_SHA256) {
      unlock();
    } else {
      $("login-password").focus();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initGate);
  } else {
    initGate();
  }
})();
