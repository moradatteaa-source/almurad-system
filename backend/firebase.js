import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDtEJYJrmyP45qS2da8Cuc6y6Jv5VD0Uhc",
  authDomain: "almurad-system.firebaseapp.com",
  databaseURL: "https://almurad-system-default-rtdb.firebaseio.com/",
  projectId: "almurad-system",
  storageBucket: "almurad-system.appspot.com",
  messagingSenderId: "911755824405",
  appId: "1:911755824405:web:2bfbd18ddcf038ca48ad1c"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export { db };