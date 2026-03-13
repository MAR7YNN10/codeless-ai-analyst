import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// Your verified Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCpjReYF1POZD9CyRnu_MRk63WH0BzVlVM",
  authDomain: "codeless-ai-analyst.firebaseapp.com",
  projectId: "codeless-ai-analyst",
  storageBucket: "codeless-ai-analyst.firebasestorage.app",
  messagingSenderId: "729417125223",
  appId: "1:729417125223:web:d734af49e54fea7f68f3c2"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export these so App.jsx can use them for the login popup
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();