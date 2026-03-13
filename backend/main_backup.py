import io
import uuid
import os
import json
from typing import List, Dict, Any

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
import requests
from dotenv import load_dotenv

# LangChain imports
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser

# ---------------- ENV + CONFIG ----------------

load_dotenv()

LMSTUDIO_MODEL_NAME = os.getenv("LMSTUDIO_MODEL_NAME", "meta-llama-3-8b-instruct")
LMSTUDIO_BASE_URL = os.getenv("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234/v1")
LMSTUDIO_API_KEY = os.getenv("LMSTUDIO_API_KEY", "lm-studio")

# n8n intent postprocess webhook
N8N_INTENT_URL = os.getenv("N8N_INTENT_URL", "http://localhost:5678/webhook/intent-hook")

app = FastAPI()

# CORS for your React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session store
SESSIONS: Dict[str, pd.DataFrame] = {}

# ---------------- Pydantic MODELS ----------------

class UploadResponse(BaseModel):
    session_id: str
    columns: List[str]
    dtypes: Dict[str, str]

class AnalyzeRequest(BaseModel):
    session_id: str
    question: str

class ChartConfig(BaseModel):
    engine: str
    type: str
    labels: List[Any]
    datasets: List[Dict[str, Any]]

class AnalyzeResponse(BaseModel):
    summary: str
    chart: ChartConfig
    table_preview: List[Dict[str, Any]]
    intent: Dict[str, Any] | None = None  # expose intent if you want to see it

# ---------------- LangChain SETUP ----------------

llm = ChatOpenAI(
    model=LMSTUDIO_MODEL_NAME,
    base_url=LMSTUDIO_BASE_URL,
    api_key=LMSTUDIO_API_KEY,
    temperature=0.2,
)

intent_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            (
                "You are a data visualization intent parser. "
                "You ALWAYS respond with a single JSON object and nothing else. "
                "No markdown, no backticks, no explanation. "
                "The JSON must have exactly these keys:\n"
                "- metric: string, column name to aggregate\n"
                "- aggregation: one of 'sum', 'avg', 'mean', 'count'\n"
                "- group_by: array of column names\n"
                "- filters: array of objects with keys 'column', 'op', and 'value' "
                "(op in ['=','!=','>','<'])\n"
                "- chart_type: e.g. 'bar', 'line', 'pie'\n"
            ),
        ),
        (
            "human",
            "Question: {question}\n\nSchema (JSON): {schema_json}",
        ),
    ]
)

intent_parser = JsonOutputParser()
intent_chain = intent_prompt | llm | intent_parser

# ---------------- SUMMARIZER ----------------

def summarize_results(df: pd.DataFrame, question: str) -> str:
    """Summarize results using LM Studio directly."""
    if df.empty:
        return "No data matched the specified filters."

    preview = df.head(10).to_dict(orient="records")
    prompt = f"""
Provide a concise summary (3–4 sentences, plain English).
Question: {question}
Results sample:
{json.dumps(preview, indent=2)}
"""

    resp = requests.post(
        f"{LMSTUDIO_BASE_URL}/chat/completions",
        json={
            "model": LMSTUDIO_MODEL_NAME,
            "messages": [
                {"role": "system", "content": "You are a data analyst."},
                {"role": "user", "content": prompt},
            ],
        },
    )

    try:
        content = resp.json()["choices"][0]["message"]["content"]
        return content.strip()
    except Exception:
        return "Summary could not be generated, but the chart shows the computed results."

# ---------------- INTENT APPLICATION ----------------

def apply_intent(df: pd.DataFrame, intent: Dict[str, Any]):
    metric = intent.get("metric")
    agg = (intent.get("aggregation") or "sum").lower()
    group_by = intent.get("group_by") or []
    filters = intent.get("filters") or []
    chart_type = intent.get("chart_type") or "bar"

    if not metric or metric not in df.columns:
        raise HTTPException(status_code=400, detail=f"Invalid or missing metric in intent: {metric}")

    filtered = df.copy()

    # Apply filters
    for f in filters:
        col = f.get("column")
        op = (f.get("op") or "=").lower()
        value = f.get("value")
        if col not in filtered.columns:
            continue
        if op in ("=", "=="):
            filtered = filtered[filtered[col] == value]
        elif op == "!=":
            filtered = filtered[filtered[col] != value]
        elif op == ">":
            filtered = filtered[filtered[col] > value]
        elif op == "<":
            filtered = filtered[filtered[col] < value]

    # Grouping
    if group_by:
        grouped = filtered.groupby(group_by)[metric]
        if agg == "sum":
            result = grouped.sum().reset_index()
        elif agg in ("avg", "mean"):
            result = grouped.mean().reset_index()
        elif agg == "count":
            result = grouped.count().reset_index()
        else:
            result = grouped.sum().reset_index()
    else:
        # No group_by: single aggregated value
        if agg == "sum":
            val = filtered[metric].sum()
        elif agg in ("avg", "mean"):
            val = filtered[metric].mean()
        elif agg == "count":
            val = filtered[metric].count()
        else:
            val = filtered[metric].sum()
        result = pd.DataFrame({metric: [val]})

    # Chart data
    labels = (
        result[group_by[0]].astype(str).tolist()
        if group_by
        else ["result"]
    )
    values = result[metric].tolist()

    chart = ChartConfig(
        engine="chartjs",
        type=chart_type,
        labels=labels,
        datasets=[{"label": f"{agg} of {metric}", "data": values}],
    )

    return result, chart

# ---------------- ROUTES ----------------

@app.post("/upload_csv", response_model=UploadResponse)
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV is supported")

    contents = await file.read()
    df = pd.read_csv(io.BytesIO(contents))

    session_id = str(uuid.uuid4())
    SESSIONS[session_id] = df

    return UploadResponse(
        session_id=session_id,
        columns=df.columns.tolist(),
        dtypes=df.dtypes.apply(str).to_dict(),
    )

@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest):
    if req.session_id not in SESSIONS:
        raise HTTPException(status_code=404, detail="Session not found")

    df = SESSIONS[req.session_id]

    schema = {
        "columns": list(df.columns),
        "dtypes": df.dtypes.apply(str).to_dict(),
        "sample": df.head(5).to_dict(orient="records"),
    }

    schema_json = json.dumps(schema, ensure_ascii=False)

    # --------- 1) LangChain: NL → Intent JSON ----------
    try:
        intent = intent_chain.invoke(
            {
                "question": req.question,
                "schema_json": schema_json,
            }
        )
    except Exception as e:
        # Fallback: fixed intent so app still works
        intent = {
            "metric": "age",
            "aggregation": "avg",
            "group_by": ["service"],
            "filters": [],
            "chart_type": "bar",
            "_warning": f"LangChain/LLM failed, used fallback intent. Error: {str(e)}",
        }

    print("INTENT FROM LANGCHAIN:", intent)

    # --------- 2) n8n: post-process intent ----------
    try:
        n8n_resp = requests.post(N8N_INTENT_URL, json=intent, timeout=5)
        n8n_resp.raise_for_status()
        processed_intent = n8n_resp.json()
        intent = processed_intent
        print("INTENT AFTER N8N:", intent)
    except Exception as e:
        print("n8n postprocess failed, using original intent:", e)

    # --------- 3) Apply intent on DataFrame ----------
    try:
        result_df, chart = apply_intent(df, intent)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error applying intent: {e}")

    summary = summarize_results(result_df, req.question)
    preview = result_df.head(10).to_dict(orient="records")

    return AnalyzeResponse(
        summary=summary,
        chart=chart,
        table_preview=preview,
        intent=intent,
    )
