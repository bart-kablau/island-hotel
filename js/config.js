// Firebase web config of the project (not secret: access is decided by the security rules).
// Project island-hotel-jjb, owner kablau@gmail.com (created 03-11-2026).
export const firebaseConfig = {
  apiKey: 'AIzaSyB95s-jG4zDySAuJ9uaqgygxBdQFR6mtto',
  // Same domain as the app: the sign-in helper is a copy in repo bart-kablau.github.io (/__/auth/), else
  // Safari, iPhone and in-app browsers block firebaseapp.com storage and the Google sign-in hangs.
  authDomain: 'bart-kablau.github.io',
  projectId: 'island-hotel-jjb',
  appId: '1:138359449876:web:4dab30aa7619730d003a01'
};

// On this laptop the app talks to the local emulators instead of the real project.
export const USE_EMULATOR = ['localhost', '127.0.0.1'].includes(location.hostname);
export const SDK = 'https://www.gstatic.com/firebasejs/11.10.0/';
export const TIMEZONE = 'Africa/Banjul';
// Bookings are loaded live from this many days back; older ones on request.
export const DAYS_BACK = 14;
