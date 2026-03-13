import { useState, useEffect, useRef } from "react";
import ChartRenderer from "./ChartRenderer";

import { 
  auth, 
  googleProvider 
} from "./firebase";
import { 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged,
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword      
} from "firebase/auth";

const API_BASE_URL = "https://codeless-ai-analyst.onrender.com";

export default function App() {
  const [csv, setCsv] = useState(null);
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);

  const [chatFeed, setChatFeed] = useState([]); 
  const [savedThreads, setSavedThreads] = useState([]); 
  const [lastIntent, setLastIntent] = useState(null); 
  const [isSidebarOpen, setIsSidebarOpen] = useState(true); 
  
  const [mainQuestion, setMainQuestion] = useState("");
  const [followUpQuestion, setFollowUpQuestion] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);

  const feedEndRef = useRef(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const [user, setUser] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);
    });
    return () => unsubscribe(); 
  }, []);

  const handleGoogleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleEmailAuth = async (e) => {
    e.preventDefault();
    try {
      if (isRegistering) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (error) {
      alert(error.message);
    }
  };

  useEffect(() => {
    if (user) {
      fetch(`${API_BASE_URL}/get_threads?user_id=${user.uid}`)
        .then(res => res.json())
        .then(data => setSavedThreads(data))
        .catch(err => console.error("Failed to load DB history:", err));
    } else {
      setSavedThreads([]); 
      setChatFeed([]);    
      setCsv(null);        
      setSessionId("");    
    }
  }, [user]); 

  async function uploadFile() {
    if (!csv) { alert("🚨 Please select a CSV file first!"); return; }
    try {
      const formData = new FormData();
      formData.append("file", csv);
      formData.append("user_id", user.uid); 

      const res = await fetch(`${API_BASE_URL}/upload_csv`, { 
        method: "POST", 
        body: formData 
      });

      if (!res.ok) throw new Error("Server rejected the file.");
      const data = await res.json();
      
      setSessionId(data.session_id);
      alert("✅ File Uploaded Successfully!");
    } catch (error) {
      alert("❌ Upload Failed: " + error.message);
    }
  }

  function removeFile() {
    setCsv(null);
    setSessionId("");
    
    const fileInput = document.getElementById("csv-upload-input");
    if (fileInput) {
      fileInput.value = ""; 
    }
  }

  async function analyze(query, isFollowUp) {
    if (!query) return;
    
    if (!sessionId) { alert("Please upload a CSV file first!"); return; }
    if (!user) { alert("You must be logged in to analyze data."); return; }
    
    setLoading(true);

    const intentToSend = isFollowUp ? lastIntent : null;
    const newUserMessage = { role: "user", text: query };
    const updatedFeed = [...(isFollowUp ? chatFeed : []), newUserMessage];
    setChatFeed(updatedFeed);

    if (!isFollowUp) setMainQuestion(""); 
    else setFollowUpQuestion(""); 

    try {
      const res = await fetch(`${API_BASE_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          question: query, 
          session_id: sessionId, 
          user_id: user.uid, 
          previous_intent: intentToSend 
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.detail || `Server Error: ${res.status}`);
      }

      const data = await res.json();
      if (data.intent) setLastIntent(data.intent);

      const aiResponse = { 
        role: "ai", 
        chart: data.chart, 
        summary: data.summary, 
        intent: data.intent 
      };
      
      const finalFeed = [...updatedFeed, aiResponse];
      setChatFeed(finalFeed);
      
      saveThreadToDatabase(query, finalFeed, data.intent || lastIntent, sessionId, false, user.uid);

    } catch (error) {
      console.error("Error analyzing:", error);
      alert(`❌ Analysis Failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveThreadToDatabase(firstQuery, feed, intent, currentSessionId, isPinned, userId) {
    // FIX: Using feed.length to prevent phantom thread creation
    const threadId = feed.length > 2 
      ? savedThreads.find(t => t.feed[0]?.text === feed[0]?.text)?.id || Date.now().toString() 
      : Date.now().toString();
    
    const threadData = {
      id: threadId,
      title: feed[0]?.text.substring(0, 30) + "...",
      feed: feed,
      lastIntent: intent,
      sessionId: currentSessionId,
      pinned: isPinned,
      user_id: userId 
    };

    try {
      await fetch(`${API_BASE_URL}/save_thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(threadData)
      });

      const res = await fetch(`${API_BASE_URL}/get_threads?user_id=${userId}`);
      setSavedThreads(await res.json());
    } catch (error) {
      console.error("Failed to save to DB", error);
    }
  }

  async function togglePin(e, thread) {
    e.stopPropagation();
    
    if (!user) return;

    const newStatus = thread.pinned ? 0 : 1; 

    try {
      const response = await fetch(`${API_BASE_URL}/update_pin/${thread.id}?pinned=${newStatus}&user_id=${user.uid}`, {
        method: "PUT" 
      });

      if (response.ok) {
        setSavedThreads(prev => prev.map(t => 
          t.id === thread.id ? { ...t, pinned: newStatus } : t
        ));
      } else {
        console.error("Server rejected the pin update. Check your permissions.");
      }
    } catch (err) {
      console.error("Failed to toggle pin:", err);
    }
  }

  async function deleteThread(e, id) {
    e.stopPropagation();
    
    if (!user) return;
    if (!window.confirm("Are you sure you want to delete this dashboard?")) return;

    try {
      // FIX: URL defined first
      const deleteUrl = `${API_BASE_URL}/delete_thread/${id}?user_id=${user.uid}`;
      
      const response = await fetch(deleteUrl, { method: "DELETE" });

      if (!response.ok) throw new Error("Unauthorized or Thread not found");

      const res = await fetch(`${API_BASE_URL}/get_threads?user_id=${user.uid}`);
      const updated = await res.json();
      setSavedThreads(updated);

      if (updated.length === 0) startNewChat();

      alert("✅ Dashboard deleted successfully.");
    } catch (error) {
      console.error("Failed to delete", error);
      alert("❌ Delete failed: " + error.message);
    }
  }

  async function renameThread(e, id, currentTitle) {
    e.stopPropagation();
    if (!user) return;

    const newTitle = window.prompt("Rename this dashboard:", currentTitle);
    if (!newTitle || newTitle.trim() === "" || newTitle === currentTitle) return;

    try {
      const res = await fetch(`${API_BASE_URL}/rename_thread/${id}?user_id=${user.uid}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() })
      });

      if (!res.ok) throw new Error("Unauthorized or server error");
      
      setSavedThreads(prev => prev.map(thread => 
        thread.id === id ? { ...thread, title: newTitle.trim() } : thread
      ));
    } catch (error) {
      console.error("Failed to rename", error);
      alert("❌ Rename failed.");
    }
  }

  function startNewChat() {
    setChatFeed([]);
    setLastIntent(null);
    setSessionId("");
  }

  function loadOldThread(thread) {
    setChatFeed(thread.feed);
    setLastIntent(thread.lastIntent);
    setSessionId(thread.sessionId); 
  }

  if (isAuthLoading) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-slate-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-slate-900 font-sans p-4">
        <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 max-w-md w-full">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-bold text-white mb-2 tracking-tight">Codeless AI Analyst Platform</h2>
            <p className="text-slate-400">{isRegistering ? "Create your analyst account" : "Secure Enterprise Analytics"}</p>
          </div>

          <form onSubmit={handleEmailAuth} className="space-y-4 mb-6">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1 tracking-wider">Email Address</label>
              <input 
                type="email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com" 
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white outline-none focus:ring-2 focus:ring-indigo-500 transition-all shadow-inner" 
                required 
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1 tracking-wider">Password</label>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••" 
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white outline-none focus:ring-2 focus:ring-indigo-500 transition-all shadow-inner" 
                required 
              />
            </div>
            <button type="submit" className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg transition-all shadow-lg active:scale-95">
              {isRegistering ? "Create Account" : "Sign In"}
            </button>
            <div className="text-center mt-4">
              <button 
                type="button"
                onClick={() => setIsRegistering(!isRegistering)}
                className="text-sm text-indigo-400 hover:text-indigo-300 underline underline-offset-4 transition-colors"
              >
                {isRegistering ? "Already have an account? Sign In" : "Need an account? Register here"}
              </button>
            </div>
          </form>

          <div className="relative my-8 text-center">
            <hr className="border-slate-700" />
            <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-slate-800 px-4 text-xs text-slate-500 uppercase tracking-widest font-semibold">Or</span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button 
              type="button"
              onClick={handleGoogleLogin} 
              className="flex items-center justify-center gap-2 py-3 bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium rounded-lg border border-slate-600 transition-all active:scale-95 shadow-sm"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              Google
            </button>
            <button type="button" className="flex items-center justify-center gap-2 py-3 bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium rounded-lg border border-slate-600 transition-all opacity-50 cursor-not-allowed shadow-sm" title="Microsoft SSO - Coming Soon">
              Microsoft
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen bg-slate-50 font-sans overflow-hidden">
      
      {/* 1. DARK ENTERPRISE SIDEBAR */}
      <div className={`flex flex-col bg-slate-900 text-slate-300 transition-all duration-300 ${isSidebarOpen ? 'w-72' : 'w-0 overflow-hidden'}`}>
        
        <div className="flex-1 p-5 overflow-y-auto pr-1">
          <button 
            onClick={startNewChat} 
            className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md transition-colors mb-8 whitespace-nowrap flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
            New Dashboard
          </button>
          
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 whitespace-nowrap">Past Queries</h4>
          
          <div className="space-y-2">
            {savedThreads.map(thread => (
              <div 
                key={thread.id} 
                onClick={() => loadOldThread(thread)} 
                className="group flex items-center justify-between p-3 bg-slate-800 hover:bg-slate-700 rounded-lg cursor-pointer transition-colors border border-slate-700 hover:border-slate-600 shadow-sm"
              >
                <span className="text-sm font-medium text-slate-200 truncate max-w-[140px]">
                  {thread.pinned ? "📌 " : ""}{thread.title}
                </span>
                
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={(e) => togglePin(e, thread)} 
                    className={`p-1 transition-colors ${thread.pinned ? 'text-yellow-400' : 'text-slate-400 hover:text-yellow-400'}`} 
                    title={thread.pinned ? "Unpin" : "Pin"}
                  >
                    📌
                  </button>

                  <button 
                    onClick={(e) => renameThread(e, thread.id, thread.title)} 
                    className="p-1 text-slate-400 hover:text-blue-400 transition-colors" 
                    title="Rename"
                  >
                    ✏️
                  </button>

                  <button 
                    onClick={(e) => deleteThread(e, thread.id)} 
                    className="p-1 text-slate-400 hover:text-red-500 transition-colors" 
                    title="Delete Dashboard"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* USER PROFILE SECTION */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center gap-3">
          <img src={user.photoURL || "https://ui-avatars.com/api/?name=User"} alt="User" className="w-10 h-10 rounded-full border-2 border-slate-700" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-200 truncate">{user.displayName || "Data Analyst"}</p>
            <p className="text-xs text-slate-500 truncate">{user.email}</p>
          </div>
          <button onClick={() => signOut(auth)} className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors" title="Logout">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
          </button>
        </div>

      </div>

      {/* 2. MAIN WORKSPACE */}
      <div className="flex-1 flex flex-col min-w-0 bg-slate-50 relative">
        
        {/* TOP NAVBAR */}
        <div className="flex items-center gap-4 bg-white px-6 py-4 shadow-sm border-b border-slate-200 z-10">
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 text-slate-500 hover:bg-slate-100 rounded-md transition-colors">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
          </button>
          
          {/* UPLOAD / ACTIVE FILE BADGE */}
          {!sessionId ? (
            <div className="flex items-center gap-2">
              <input id="csv-upload-input" type="file" onChange={(e) => setCsv(e.target.files[0])} className="text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 cursor-pointer transition-colors" />
              <button onClick={uploadFile} className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-sm font-medium rounded-md shadow-sm transition-colors">Upload</button>
            </div>
          ) : (
            <div className="flex items-center gap-2 bg-emerald-50 px-3 py-1.5 rounded-full border border-emerald-200 shadow-sm">
              <span className="text-emerald-700 font-semibold text-sm flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                File Active
              </span>
              <button onClick={removeFile} className="ml-2 w-5 h-5 flex items-center justify-center bg-emerald-200 hover:bg-red-500 hover:text-white text-emerald-800 rounded-full text-xs transition-colors" title="Remove File">✖</button>
            </div>
          )}
          
          {/* MAIN SEARCH BAR */}
          <div className="flex-1 flex gap-2">
            <input value={mainQuestion} onChange={(e) => setMainQuestion(e.target.value)} placeholder="Ask your data anything..." className="flex-1 bg-slate-100 border-transparent focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 rounded-lg px-4 py-2 text-slate-700 outline-none transition-all shadow-inner" onKeyPress={(e) => e.key === 'Enter' && analyze(mainQuestion, false)} />
            <button onClick={() => analyze(mainQuestion, false)} disabled={loading} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium rounded-lg shadow-md transition-colors flex items-center gap-2">
              {loading ? ( <span className="animate-pulse">Analyzing...</span> ) : ( <>Analyze <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg></> )}
            </button>
          </div>
        </div>

        {/* 3. CHAT FEED */}
        <div className="flex-1 overflow-y-auto p-6 lg:p-10 space-y-8 scroll-smooth">
          {chatFeed.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center max-w-md mx-auto mt-10">
              <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mb-6 shadow-inner">
                <svg className="w-10 h-10 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
              </div>
              <h2 className="text-2xl font-bold text-slate-800 mb-2">Codeless AI Analyst Platform</h2>
              <p className="text-slate-500">Upload a CSV dataset and type your query above to generate instant enterprise-grade visualizations.</p>
            </div>
          ) : (
            chatFeed.map((msg, index) => (
              <div key={index} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                
                {/* USER BUBBLE */}
                {msg.role === "user" ? (
                  <div className="max-w-[80%] bg-indigo-600 text-white px-6 py-4 rounded-2xl rounded-tr-sm shadow-md">
                    <strong className="block text-indigo-200 text-xs uppercase tracking-wider mb-1">You</strong>
                    <span className="text-lg">{msg.text}</span>
                  </div>
                ) : (
                  
                /* AI BUBBLE */
                  <div className="w-full max-w-5xl bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                    <div className="bg-slate-50 px-6 py-3 border-b border-slate-100 flex items-center gap-2">
                       <span className="text-xl">🤖</span>
                       <strong className="text-slate-700 font-semibold">AI Analyst</strong>
                    </div>
                    <div className="p-6">
                      {msg.chart && (
                        <div className="mb-6 border border-slate-100 rounded-xl overflow-hidden shadow-sm bg-white">
                          <ChartRenderer chart={msg.chart} intent={msg.intent} />
                        </div>
                      )}
                      {msg.summary && (
                        <div className="text-slate-700 leading-relaxed bg-slate-50 p-6 rounded-xl border border-slate-100 shadow-inner">
                          {msg.summary}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}

          {/* NEW ENTERPRISE LOADING ANIMATION */}
          {loading && (
            <div className="flex justify-start">
              <div className="w-full max-w-5xl bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col mb-4">
                <div className="bg-slate-50 px-6 py-3 border-b border-slate-100 flex items-center gap-2">
                   <span className="text-xl animate-bounce">🤖</span>
                   <strong className="text-slate-700 font-semibold">AI Analyst is thinking...</strong>
                </div>
                <div className="p-6 flex items-center gap-3 text-slate-500">
                  <svg className="animate-spin h-5 w-5 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>Processing data and generating your chart...</span>
                </div>
              </div>
            </div>
          )}
          <div ref={feedEndRef} />
        </div>

        {/* 4. BOTTOM FOLLOW-UP BAR */}
        {chatFeed.length > 0 && (
          <div className="bg-white border-t border-slate-200 p-4 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.05)] z-10">
            <div className="max-w-5xl mx-auto flex gap-3">
              <input value={followUpQuestion} onChange={(e) => setFollowUpQuestion(e.target.value)} placeholder="Ask a follow-up (e.g., 'Now group it by gender')..." className="flex-1 bg-slate-50 border border-slate-300 focus:bg-white focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 rounded-lg px-4 py-3 text-slate-700 outline-none transition-all shadow-inner" onKeyPress={(e) => e.key === 'Enter' && analyze(followUpQuestion, true)} />
              <button onClick={() => analyze(followUpQuestion, true)} disabled={loading} className="px-8 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white font-semibold rounded-lg shadow-md transition-colors flex items-center gap-2">
                {loading ? "Thinking..." : "Follow Up"}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}