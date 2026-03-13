import io
import uuid
import os
import json
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
import requests
from dotenv import load_dotenv
from sqlalchemy import create_engine, Column, String, Boolean, Text
from sqlalchemy.orm import declarative_base, sessionmaker, Session

# ---------------- CONFIG & DB SETUP ----------------
UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
load_dotenv()

# THE FIX: We are using Supabase to bypass your network blocking Neon
# Replace MyDatabasePassword123! with your actual Supabase password
SQLALCHEMY_DATABASE_URL = "postgresql://postgres.grhrkhcbtczaobarvemp:M%40r7yNnXleom10@aws-1-ap-south-1.pooler.supabase.com:5432/postgres"

print("\n=== CONNECTING TO CLOUD DATABASE ===")
print(SQLALCHEMY_DATABASE_URL)
print("====================================\n")

engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class DBThread(Base):
    __tablename__ = "threads"
    id = Column(String, primary_key=True, index=True)
    title = Column(String)
    feed = Column(Text)
    last_intent = Column(Text)
    session_id = Column(String)
    pinned = Column(Boolean, default=False)
    user_id = Column(String)

# Build tables in the cloud
Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ---------------- APP SETUP ----------------
LMSTUDIO_MODEL_NAME = os.getenv("LMSTUDIO_MODEL_NAME", "meta-llama-3-8b-instruct")
LMSTUDIO_BASE_URL = os.getenv("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234/v1")
N8N_INTENT_URL = os.getenv("N8N_INTENT_URL", "https://kori-conferval-nonverminously.ngrok-free.dev/webhook/api-gateway")
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------- Pydantic MODELS ----------------
class UploadResponse(BaseModel):
    session_id: str
    columns: List[str]
    dtypes: Dict[str, str]

class AnalyzeRequest(BaseModel):
    session_id: str
    question: str
    user_id: str
    previous_intent: Optional[Dict[str, Any]] = None

class AnalyzeResponse(BaseModel):
    summary: str
    chart: Dict[str, Any]
    table_preview: List[Dict[str, Any]]
    intent: Optional[Dict[str, Any]] = None

class ThreadCreate(BaseModel):
    id: str
    title: str
    feed: list
    lastIntent: Optional[Dict[str, Any]] = None
    sessionId: str
    pinned: bool = False
    user_id: str

class ThreadRename(BaseModel):
    title: str

# ---------------- CORE FUNCTIONS ----------------
def summarize_results(df: pd.DataFrame, question: str, intent: dict) -> str:
    if df.empty:
        return "No data matched the specified filters."
    preview = df.head(10).to_dict(orient="records")
    prompt = f"""
You are looking at the final processed data. Provide a concise business summary (3–4 sentences, plain English).
CRITICAL CONTEXT:
The data has ALREADY been mathematically filtered based on this user intent: {json.dumps(intent)}
Question: {question}
Results sample:
{json.dumps(preview, indent=2)}
"""
    gemini_url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    api_key = os.getenv("GEMINI_API_KEY") 
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    try:
        resp = requests.post(
            gemini_url,
            headers=headers,
            json={
                "model": "gemini-2.5-flash-lite",
                "messages": [
                    {"role": "system", "content": "You are an expert executive data analyst. You only report on data insights. You never write code."},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
            },
            timeout=15
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"Summary generation failed: {e}")
        return "Summary could not be generated, but the chart shows the computed results."
    
def apply_intent(df: pd.DataFrame, intent: Dict[str, Any]):
    chart_type = intent.get("chart_type", "bar").lower()
    is_donut = False
    if chart_type in ["donut", "ring"]:
        chart_type = "pie"
        is_donut = True

    group_by = intent.get("group_by") or []
    if isinstance(group_by, str):
        group_by = [group_by]
    intent["group_by"] = group_by

    filtered = df.copy()
    filters = intent.get("filters") or []
    for f in filters:
        col = f.get("column")
        op = (f.get("operator") or f.get("op") or "=").lower()
        value = f.get("value")
        if col not in filtered.columns: continue
        if op in ("=", "==", "contains"): 
            if isinstance(value, str):
                filtered = filtered[filtered[col].astype(str).str.contains(value, case=False, na=False)]
            else:
                filtered = filtered[filtered[col] == value]
        elif op == "!=": filtered = filtered[filtered[col] != value]
        elif op == ">": filtered = filtered[filtered[col] > float(value)]
        elif op == "<": filtered = filtered[filtered[col] < float(value)]

    if chart_type in ["radar", "scatterpolar"]:
        metric = intent.get("metric", "Cost")
        group_col = intent["group_by"][0] if len(intent["group_by"]) > 0 else "Condition"
        agg = intent.get("aggregation", "mean").lower()
        grouped = filtered.groupby(group_col)[metric]
        if agg == "sum": result = grouped.sum().reset_index()
        elif agg == "count": result = filtered.groupby(group_col).size().reset_index(name=metric)
        else: result = grouped.mean().reset_index()
        chart_data = {"type": "scatterpolar", "r": result[metric].tolist(), "theta": result[group_col].astype(str).tolist(), "fill": "toself", "generated_title": intent.get("generated_title", f"{agg.title()} of {metric} by {group_col}")}
        return result, chart_data
    
    elif chart_type in ["sunburst", "treemap"]:
        labels_col = intent.get("labels", filtered.columns[0])
        parents_col = intent.get("parents", filtered.columns[1])
        values_col = intent.get("values", filtered.columns[2] if len(filtered.columns) > 2 else filtered.columns[0])
        child_level = filtered.groupby([parents_col, labels_col])[values_col].sum().reset_index()
        parent_level = filtered.groupby(parents_col)[values_col].sum().reset_index()
        total_val = float(parent_level[values_col].sum())
        ids = ["Total"] + parent_level[parents_col].tolist() + (child_level[parents_col] + " - " + child_level[labels_col]).tolist()
        labels = ["Total Patients"] + parent_level[parents_col].tolist() + child_level[labels_col].tolist()
        parents = [""] + ["Total"] * len(parent_level) + child_level[parents_col].tolist()
        values = [total_val] + parent_level[values_col].tolist() + child_level[values_col].tolist()
        chart_data = {"type": chart_type, "ids": ids, "labels": labels, "parents": parents, "values": values, "branchvalues": "total", "generated_title": intent.get("generated_title", f"{chart_type.title()} of {values_col} by {parents_col}")}
        return filtered, chart_data

    elif chart_type == "heatmap":
        x_col = intent.get("x_axis", filtered.columns[0])
        y_col = intent.get("y_axis", filtered.columns[1])
        z_col = intent.get("z_axis", filtered.columns[2] if len(filtered.columns) > 2 else filtered.columns[0])
        pivot = filtered.pivot_table(index=y_col, columns=x_col, values=z_col, aggfunc='sum').fillna(0)
        chart_data = {"type": "heatmap", "x": pivot.columns.tolist(), "y": pivot.index.tolist(), "z": pivot.values.tolist(), "generated_title": intent.get("generated_title", f"Heatmap of {z_col}")}
        return filtered, chart_data

    elif chart_type == "candlestick":
        chart_data = {"type": "candlestick", "x": filtered[intent.get("x_axis", filtered.columns[0])].tolist(), "open": filtered[intent.get("open", filtered.columns[1])].tolist(), "high": filtered[intent.get("high", filtered.columns[1])].tolist(), "low": filtered[intent.get("low", filtered.columns[1])].tolist(), "close": filtered[intent.get("close", filtered.columns[1])].tolist(), "generated_title": intent.get("generated_title", "Candlestick Chart")}
        return filtered, chart_data
        
    elif chart_type == "bubble":
        x_col, y_col = intent.get("x_axis", filtered.columns[0]), intent.get("y_axis", filtered.columns[1])
        size_col = intent.get("size_column", y_col)
        sizes = filtered[size_col].fillna(0).tolist()
        max_size = max(sizes) if sizes else 1
        normalized_sizes = [(s / max_size) * 40 for s in sizes] 
        chart_data = {"type": "scatter", "mode": "markers", "x": filtered[x_col].tolist(), "y": filtered[y_col].tolist(), "marker_size": normalized_sizes, "generated_title": intent.get("generated_title", f"Bubble Chart")}
        return filtered, chart_data

    elif chart_type == "area":
        x_col, y_col = intent.get("x_axis", filtered.columns[0]), intent.get("y_axis", filtered.columns[1])
        chart_data = {"type": "scatter", "fill": "tozeroy", "x": filtered[x_col].tolist(), "y": filtered[y_col].tolist(), "generated_title": intent.get("generated_title", f"Area Chart")}
        return filtered, chart_data

    elif chart_type == "histogram":
        x_col = intent.get("x_axis", intent.get("metric", filtered.columns[0]))
        chart_data = {"type": "histogram", "x": filtered[x_col].dropna().tolist(), "generated_title": intent.get("generated_title", f"Distribution of {x_col}")}
        return filtered, chart_data

    elif chart_type in ["scatter", "scatter3d", "box", "violin", "surface"]:
        x_col = intent.get("x_axis", filtered.columns[0])
        y_col = intent.get("y_axis", filtered.columns[1] if len(filtered.columns) > 1 else x_col)
        plot_df = filtered.dropna(subset=[x_col, y_col])
        chart_data = {"type": chart_type, "x": plot_df[x_col].tolist(), "y": plot_df[y_col].tolist(), "generated_title": intent.get("generated_title", f"{chart_type.title()} Plot")}
        if intent.get("z_axis") and intent.get("z_axis") in plot_df.columns:
            chart_data["z"] = plot_df[intent.get("z_axis")].tolist()
        return plot_df, chart_data

    elif chart_type in ["bar", "line", "pie", "funnel"]:
        metric = intent.get("metric")
        agg = (intent.get("aggregation") or "sum").lower()
        group_by = intent.get("group_by")
        if not group_by and chart_type in ['bar', 'pie']:
            if 'Condition' in df.columns: group_by = ['Condition']
            elif 'Gender' in df.columns: group_by = ['Gender']
            elif 'Outcome' in df.columns: group_by = ['Outcome']
        if not metric or metric not in df.columns:
            metric = "Outcome" if "Outcome" in df.columns else df.columns[0]
        if group_by:
            if agg == "count":
                result = filtered.groupby(group_by).size().reset_index(name="Count_Value")
                display_metric = "Count_Value"
            else:
                grouped = filtered.groupby(group_by)[metric]
                if agg == "sum": result = grouped.sum().reset_index()
                elif agg in ("avg", "mean"): result = grouped.mean().reset_index()
                else: result = grouped.sum().reset_index()
                display_metric = metric
        else:
            if agg == "count": val = len(filtered)
            elif agg == "sum": val = filtered[metric].sum()
            elif agg in ("avg", "mean"): val = filtered[metric].mean()
            else: val = filtered[metric].sum()
            result = pd.DataFrame({metric: [val]})
            display_metric = metric
        if group_by and len(group_by) > 1: labels = result[group_by].astype(str).agg(' - '.join, axis=1).tolist()
        elif group_by: labels = result[group_by[0]].astype(str).tolist()
        else: labels = ["Total"]
        chart_data = {"type": chart_type, "labels": labels, "datasets": [{"label": intent.get("generated_title", f"{agg} of {metric}"), "data": result[display_metric].tolist()}], "generated_title": intent.get("generated_title", f"{agg} of {metric}")}
        if is_donut: chart_data["hole"] = 0.5
        return result, chart_data

    else:
        data_keys = [k for k in intent.keys() if k not in ["chart_type", "generated_title", "filters"]]
        if data_keys:
            cols = [intent[k] for k in data_keys if isinstance(intent[k], str)]
            smart_title = f"{chart_type.upper()} Analysis of " + " vs ".join(cols)
        else:
            smart_title = intent.get("generated_title", "Advanced Visualization")
        chart_data = {"type": chart_type, "generated_title": smart_title}
        reserved_keys = ["chart_type", "generated_title", "filters", "group_by", "aggregation", "metric"]
        for key, col_name in intent.items():
            if key not in reserved_keys and isinstance(col_name, str) and col_name in filtered.columns:
                chart_data[key] = filtered[col_name].fillna(0).tolist()
        if len(chart_data.keys()) <= 2:
            metric = intent.get("metric", filtered.columns[0])
            group_by = intent.get("group_by", [filtered.columns[0]])
            result = filtered.groupby(group_by)[metric].sum().reset_index()
            chart_data = {"type": "bar", "x": result[group_by[0]].astype(str).tolist(), "y": result[metric].tolist(), "generated_title": f"Fallback: Sum of {metric} by {group_by[0]}"}
            return result, chart_data
        return filtered, chart_data

# ---------------- API ROUTES ----------------

@app.post("/upload_csv", response_model=UploadResponse)
async def upload_csv(file: UploadFile = File(...), user_id: str = Form(...)):
    if not file.filename.endswith(".csv"): raise HTTPException(status_code=400, detail="Only CSV is supported")
    user_folder = os.path.join(UPLOAD_DIR, user_id)
    os.makedirs(user_folder, exist_ok=True)
    contents = await file.read()
    df = pd.read_csv(io.BytesIO(contents))
    session_id = str(uuid.uuid4())
    file_path = os.path.join(user_folder, f"{session_id}.csv")
    df.to_csv(file_path, index=False)
    return UploadResponse(session_id=session_id, columns=df.columns.tolist(), dtypes=df.dtypes.apply(str).to_dict())

@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):  # <--- Removed 'async' here!
    user_folder = os.path.join(UPLOAD_DIR, req.user_id)
    file_path = os.path.join(user_folder, f"{req.session_id}.csv")
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File session not found. Please re-upload your CSV.")
    df = pd.read_csv(file_path)
    schema = {"columns": list(df.columns), "dtypes": df.dtypes.apply(str).to_dict(), "sample_data": df.head(10).to_dict(orient="records"), "total_rows": len(df)}
    payload_for_n8n = {"question": req.question, "schema_json": schema, "previous_intent": req.previous_intent}
    try:
        n8n_resp = requests.post(N8N_INTENT_URL, json=payload_for_n8n, timeout=45)
        n8n_resp.raise_for_status()
        intent = n8n_resp.json()
        # --- ADD THIS LINE TO SPY ON n8n ---
        print(f"\n[DEBUG] AI INTENT: {json.dumps(intent, indent=2)}\n")
    except Exception as e:
        intent = {"metric": df.columns[0], "aggregation": "count", "group_by": [df.columns[1]] if len(df.columns) > 1 else [], "filters": [], "chart_type": "bar", "_processed_by": "fallback_error_handler"}
    try: result_df, chart = apply_intent(df, intent)
    except Exception as e: raise HTTPException(status_code=500, detail=f"Logic error: {e}")
    summary = summarize_results(result_df, req.question, intent)
    preview = result_df.head(10).to_dict(orient="records")
    return AnalyzeResponse(summary=summary, chart=chart, table_preview=preview, intent=intent)

@app.post("/save_thread")
def save_thread(thread: ThreadCreate, db: Session = Depends(get_db)):
    db_thread = db.query(DBThread).filter(DBThread.id == thread.id, DBThread.user_id == thread.user_id).first()
    feed_str = json.dumps(thread.feed)
    intent_str = json.dumps(thread.lastIntent) if thread.lastIntent else None
    if db_thread:
        db_thread.feed = feed_str
        db_thread.last_intent = intent_str
        db_thread.session_id = thread.sessionId
        db_thread.pinned = thread.pinned
    else:
        db_thread = DBThread(id=thread.id, title=thread.title, feed=feed_str, last_intent=intent_str, session_id=thread.sessionId, pinned=thread.pinned, user_id=thread.user_id)
        db.add(db_thread)
    db.commit()
    return {"status": "success"}

@app.get("/get_threads")
def get_threads(user_id: str, db: Session = Depends(get_db)):
    threads = db.query(DBThread).filter(DBThread.user_id == user_id).all()
    result = []
    for t in threads:
        result.append({"id": t.id, "title": t.title, "feed": json.loads(t.feed) if t.feed else [], "lastIntent": json.loads(t.last_intent) if t.last_intent else None, "sessionId": t.session_id, "pinned": t.pinned})
    result.sort(key=lambda x: (x["pinned"], x["id"]), reverse=True)
    return result

@app.delete("/delete_thread/{thread_id}") 
def delete_thread(thread_id: str, user_id: str, db: Session = Depends(get_db)):
    db_thread = db.query(DBThread).filter(DBThread.id == thread_id, DBThread.user_id == user_id).first()
    if db_thread:
        db.delete(db_thread)
        db.commit()
        return {"status": "deleted"}
    raise HTTPException(status_code=403, detail="Unauthorized to delete this thread or it does not exist.")

@app.put("/rename_thread/{thread_id}")
def rename_thread(thread_id: str, req: ThreadRename, user_id: str, db: Session = Depends(get_db)):
    db_thread = db.query(DBThread).filter(DBThread.id == thread_id, DBThread.user_id == user_id).first()
    if db_thread:
        db_thread.title = req.title
        db.commit()
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Thread not found or unauthorized")

@app.put("/update_pin/{thread_id}")
def update_pin(thread_id: str, pinned: int, user_id: str, db: Session = Depends(get_db)):
    db_thread = db.query(DBThread).filter(DBThread.id == thread_id, DBThread.user_id == user_id).first()
    if db_thread:
        db_thread.pinned = bool(pinned) 
        db.commit()
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Thread not found or unauthorized")