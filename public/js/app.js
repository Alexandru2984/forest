// Compatibility entry for a cached v9 HTML shell. Current releases use explorer.js.
// Discard the former session credential before requesting the fresh HTML shell.
try {
    sessionStorage.removeItem("cf_token");
    sessionStorage.removeItem("cf_user");
} catch {
    /* Storage is optional. */
}
const target = new URL(location.href);
if (!document.getElementById("profile-form")) {
    target.searchParams.set("release", "10.0.0");
    location.replace(target.href);
}
