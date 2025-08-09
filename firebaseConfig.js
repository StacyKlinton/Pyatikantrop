// src/firebaseConfig.js
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";

const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCPhzohvNOW77WONxPpgK9mCPXl84CGOEc",
  authDomain: "pyatikantrop-game.firebaseapp.com",
  databaseURL: "https://pyatikantrop-game-default-rtdb.firebaseio.com",
  projectId: "pyatikantrop-game",
  storageBucket: "pyatikantrop-game.appspot.com",
  messagingSenderId: "421071557643",
  appId: "1:421071557643:web:56046f427ee65cb452a30e"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
