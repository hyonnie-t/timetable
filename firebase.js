import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getDatabase, ref, get, set, update, onValue }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBJnR447EvbToLxtRAHFNtSlhkg61QkdfA",
  authDomain: "timetable-af612.firebaseapp.com",
  projectId: "timetable-af612",
  storageBucket: "timetable-af612.firebasestorage.app",
  messagingSenderId: "797690266953",
  appId: "1:797690266953:web:bfd4ba739900b625090698",
  databaseURL: "https://timetable-af612-default-rtdb.firebaseio.com"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();

export { ref, get, set, update, onValue, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged };
