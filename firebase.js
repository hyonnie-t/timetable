import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { initializeAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver }
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
// 새로고침/재접속해도 로그인 유지되도록 저장소를 초기화 시점에 명시한다.
// (getAuth 후 setPersistence를 부르면 저장된 세션 복원과 경합할 수 있어 initializeAuth로 대체)
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  popupRedirectResolver: browserPopupRedirectResolver
});
export const db   = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();

export { ref, get, set, update, onValue, signInWithPopup, signOut, onAuthStateChanged };
