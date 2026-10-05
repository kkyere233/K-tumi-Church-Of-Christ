from __future__ import annotations

import logging
import os
import re
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlparse

import bcrypt
from bson import ObjectId
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError
from starlette.middleware.sessions import SessionMiddleware

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

PORT = int(os.getenv("PORT", "3000"))
NODE_ENV = os.getenv("NODE_ENV", "development")
TRUST_PROXY = os.getenv("TRUST_PROXY", "0") == "1"
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://127.0.0.1:27017/church_office")
SESSION_SECRET = os.getenv("SESSION_SECRET", "")
ALLOWED_ORIGINS = {
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}
ROLES = ["Admin", "Secretary", "Financial Secretary", "Treasurer", "Member"]
MARITAL_STATUSES = ["Single", "Married", "Divorced", "Widowed", "Prefer not to say"]
MEMBER_AGE_GROUPS = ["Below 20", "20 or above"]
LEGACY_MEMBER_AGE_GROUPS = ["20 or under", "Over 20"]
LOGIN_RATE_LIMIT = 10
LOGIN_RATE_WINDOW_SECONDS = 15 * 60
_login_attempts: dict[str, deque[float]] = {}
_login_attempts_lock = Lock()

app = FastAPI(title="Kukurantumi Church Of Christ Youth Dashboard")
app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    same_site="strict",
    https_only=NODE_ENV == "production",
    max_age=8 * 60 * 60,
)
app.mount("/assets", StaticFiles(directory=str(BASE_DIR / "assets")), name="assets")


def get_database_name() -> str:
    parsed = urlparse(MONGODB_URI)
    db_name = parsed.path.lstrip("/") if parsed.path else "church_office"
    return db_name or "church_office"


def get_client() -> MongoClient:
    if not hasattr(app.state, "mongo_client"):
        app.state.mongo_client = MongoClient(MONGODB_URI)
    return app.state.mongo_client


def get_db():
    return get_client()[get_database_name()]


def serialize_value(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [serialize_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): serialize_value(item) for key, item in value.items()}
    return value


def member_age_group(member: dict[str, Any]) -> str:
    age = member.get("age")
    if isinstance(age, int) or isinstance(age, float):
        return "Below 20" if age < 20 else "20 or above"
    age_group = member.get("ageGroup") or ""
    if age_group == "20 or under":
        return "Below 20"
    if age_group == "Over 20":
        return "20 or above"
    return age_group or ""


def member_dues_amount(member: dict[str, Any]) -> int:
    return 10 if member_age_group(member) == "Below 20" else 20


def safe_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(user.get("_id")),
        "username": user.get("username"),
        "name": user.get("name"),
        "email": user.get("email"),
        "role": user.get("role"),
        "memberId": str(user.get("memberId")) if user.get("memberId") else None,
    }


async def get_authenticated_user(request: Request) -> dict[str, Any]:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Please sign in.")
    user = get_db().users.find_one({"_id": ObjectId(user_id)})
    if not user or not user.get("active", True):
        request.session.clear()
        raise HTTPException(status_code=401, detail="Your account is inactive. Sign in with an active account.")
    return user


async def ensure_same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        return
    parsed_origin = urlparse(origin)
    if parsed_origin.scheme not in {"http", "https"}:
        raise HTTPException(status_code=403, detail="Invalid request origin.")
    forwarded_proto = request.headers.get("x-forwarded-proto") if TRUST_PROXY else None
    scheme = forwarded_proto or request.url.scheme
    host = request.headers.get("host") or request.url.netloc
    request_origin = f"{scheme}://{host}"
    if parsed_origin.scheme + "://" + parsed_origin.netloc not in {request_origin, *ALLOWED_ORIGINS}:
        raise HTTPException(status_code=403, detail="Request origin is not allowed.")


def enforce_login_rate_limit(request: Request) -> None:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if TRUST_PROXY and forwarded_for:
        client_ip = forwarded_for.split(",")[-1].strip()
    else:
        client_ip = request.client.host if request.client else "unknown"

    now = time.monotonic()
    window_start = now - LOGIN_RATE_WINDOW_SECONDS
    with _login_attempts_lock:
        attempts = _login_attempts.setdefault(client_ip, deque())
        while attempts and attempts[0] <= window_start:
            attempts.popleft()
        if len(attempts) >= LOGIN_RATE_LIMIT:
            retry_after = max(1, int(attempts[0] + LOGIN_RATE_WINDOW_SECONDS - now + 0.999))
            raise HTTPException(
                status_code=429,
                detail="Too many login attempts. Please try again later.",
                headers={
                    "Retry-After": str(retry_after),
                    "RateLimit-Limit": str(LOGIN_RATE_LIMIT),
                    "RateLimit-Remaining": "0",
                    "RateLimit-Reset": str(retry_after),
                    "RateLimit-Policy": f"{LOGIN_RATE_LIMIT};w={LOGIN_RATE_WINDOW_SECONDS}",
                },
            )
        attempts.append(now)

        expired_clients = [ip for ip, entries in _login_attempts.items() if not entries or entries[-1] <= window_start]
        for ip in expired_clients:
            del _login_attempts[ip]


@app.middleware("http")
async def origin_guard(request: Request, call_next):
    if request.url.path.startswith("/api"):
        try:
            await ensure_same_origin(request)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
    response = await call_next(request)
    return response


@app.on_event("startup")
def startup_event() -> None:
    if len(SESSION_SECRET) < 32:
        raise RuntimeError("SESSION_SECRET must contain at least 32 characters.")
    get_client().admin.command("ping")
    get_db()
    get_db().users.create_index("username", unique=True, sparse=True)
    get_db().users.create_index("email", unique=True)
    maybe_create_bootstrap_admin()


def maybe_create_bootstrap_admin() -> None:
    db = get_db()
    if db.users.find_one({"role": "Admin"}):
        return
    name = os.getenv("BOOTSTRAP_ADMIN_NAME", "").strip()
    email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
    username = os.getenv("BOOTSTRAP_ADMIN_USERNAME", email.split("@")[0] if email else "").strip().lower()
    password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
    if not (re.fullmatch(r"[a-z0-9._-]{3,32}", username) and len(name) >= 2 and re.fullmatch(r"\S+@\S+\.\S+", email) and len(password) >= 8):
        raise RuntimeError("Set BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL, and a BOOTSTRAP_ADMIN_PASSWORD of at least 8 characters for the first Admin.")
    db.users.insert_one(
        {
            "username": username,
            "name": name,
            "email": email,
            "passwordHash": bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"),
            "role": "Admin",
            "memberId": None,
            "active": True,
            "createdAt": datetime.now(timezone.utc),
            "updatedAt": datetime.now(timezone.utc),
        }
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def login_page() -> FileResponse:
    return FileResponse(BASE_DIR / "login.html")


@app.get("/login")
def login_page_alias() -> FileResponse:
    return FileResponse(BASE_DIR / "login.html")


@app.get("/dashboard")
async def dashboard_page(request: Request) -> FileResponse:
    await get_authenticated_user(request)
    return FileResponse(BASE_DIR / "COC jct.html")


@app.get("/api/auth/me")
async def get_me(request: Request) -> dict[str, Any]:
    user = await get_authenticated_user(request)
    response = {"user": safe_user(user)}
    if user.get("role") == "Member" and user.get("memberId"):
        member = get_db().members.find_one({"_id": ObjectId(user["memberId"])}, {"age": 1, "ageGroup": 1})
        if member:
            response["user"]["ageGroup"] = member_age_group(member) or "20 or above"
            response["user"]["monthlyDues"] = member_dues_amount(member)
    return response


@app.post("/api/auth/login")
async def login(request: Request) -> dict[str, Any]:
    enforce_login_rate_limit(request)
    payload = await request.json()
    username = str(payload.get("username", "")).strip().lower()
    password = str(payload.get("password", ""))
    if not username or not password or len(password) > 200:
        raise HTTPException(status_code=400, detail="Enter your username and password.")
    user = get_db().users.find_one({"$or": [{"username": username}, {"email": username}]})
    if not user or not user.get("active", True):
        raise HTTPException(status_code=401, detail="Username or password is incorrect.")
    password_hash = user.get("passwordHash", "")
    if not isinstance(password_hash, str) or not bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Username or password is incorrect.")
    request.session.clear()
    request.session["user_id"] = str(user["_id"])
    return {"user": safe_user(user)}


@app.post("/api/auth/logout")
async def logout(request: Request) -> None:
    await get_authenticated_user(request)
    request.session.clear()
    return JSONResponse(status_code=204, content=None)


@app.get("/api/users")
async def list_users(request: Request) -> list[dict[str, Any]]:
    user = await get_authenticated_user(request)
    if user.get("role") != "Admin":
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    rows = list(get_db().users.find().sort("name", 1))
    return [serialize_value({
        "id": str(item["_id"]),
        "username": item.get("username"),
        "name": item.get("name"),
        "email": item.get("email"),
        "role": item.get("role"),
        "memberId": str(item.get("memberId")) if item.get("memberId") else None,
        "active": item.get("active", True),
        "createdAt": item.get("createdAt"),
    }) for item in rows]


@app.post("/api/users")
async def create_user(request: Request) -> dict[str, Any]:
    admin = await get_authenticated_user(request)
    if admin.get("role") != "Admin":
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    payload = await request.json()
    username = str(payload.get("username", "")).strip().lower()
    name = str(payload.get("name", "")).strip()
    email = str(payload.get("email", "")).strip().lower()
    password = str(payload.get("password", ""))
    role = str(payload.get("role", ""))
    age_group = str(payload.get("ageGroup", ""))
    if not re.fullmatch(r"[a-z0-9._-]{3,32}", username) or len(name) < 2 or not re.fullmatch(r"\S+@\S+\.\S+", email) or len(password) < 8 or role not in ROLES:
        raise HTTPException(status_code=400, detail="Provide a valid username, name, email, role, and password of at least 8 characters.")
    linked_member = None
    if role == "Member":
        if age_group not in MEMBER_AGE_GROUPS:
            raise HTTPException(status_code=400, detail="Select whether the member is below 20 or 20 or above.")
        linked_member = get_db().members.find_one({"email": email})
        if not linked_member:
            raise HTTPException(status_code=404, detail="No directory member matches this email address. Add the member with this email first.")
        if get_db().users.find_one({"memberId": linked_member["_id"]}):
            raise HTTPException(status_code=409, detail="A login is already linked to that member.")
        existing_group = member_age_group(linked_member)
        if existing_group and existing_group != age_group:
            raise HTTPException(status_code=400, detail="The selected age group does not match the member's age group in the directory.")
    try:
        user_doc = {
            "username": username,
            "name": name,
            "email": email,
            "passwordHash": bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"),
            "role": role,
            "memberId": ObjectId(linked_member["_id"]) if linked_member else None,
            "active": True,
            "createdAt": datetime.now(timezone.utc),
            "updatedAt": datetime.now(timezone.utc),
        }
        result = get_db().users.insert_one(user_doc)
        if linked_member:
            get_db().members.update_one({"_id": linked_member["_id"]}, {"$set": {"ageGroup": age_group}})
        return safe_user({"_id": result.inserted_id, **user_doc})
    except DuplicateKeyError as exc:
        raise HTTPException(status_code=409, detail="That username or email address is already in use.") from exc


@app.patch("/api/users/{user_id}")
async def update_user(request: Request, user_id: str) -> dict[str, Any]:
    admin = await get_authenticated_user(request)
    if admin.get("role") != "Admin":
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    payload = await request.json()
    user = get_db().users.find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User account not found.")
    if str(user["_id"]) == str(admin["_id"]):
        raise HTTPException(status_code=400, detail="You cannot change your own account here.")
    active = payload.get("active")
    if not isinstance(active, bool):
        raise HTTPException(status_code=400, detail="Provide an active status.")
    if not active and user.get("role") == "Admin" and get_db().users.count_documents({"role": "Admin", "active": True}) <= 1:
        raise HTTPException(status_code=400, detail="The last active Admin cannot be disabled.")
    get_db().users.update_one({"_id": user["_id"]}, {"$set": {"active": active, "updatedAt": datetime.now(timezone.utc)}})
    updated = get_db().users.find_one({"_id": user["_id"]})
    return {"id": str(updated["_id"]), "name": updated["name"], "email": updated["email"], "role": updated["role"], "active": updated["active"]}


@app.get("/api/members")
async def list_members(request: Request) -> list[dict[str, Any]]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Secretary", "Financial Secretary", "Treasurer"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    rows = list(get_db().members.find().sort("name", 1))
    output = []
    for member in rows:
        item = serialize_value(member)
        item["ageGroup"] = member_age_group(member)
        item["monthlyDues"] = member_dues_amount(member)
        if user.get("role") not in {"Admin", "Secretary"}:
            item.pop("age", None)
            item.pop("ageGroup", None)
            item.pop("maritalStatus", None)
            item.pop("contact", None)
        else:
            item.pop("age", None)
        output.append(item)
    return output


@app.post("/api/members")
async def create_member(request: Request) -> dict[str, Any]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Secretary"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    payload = await request.json()
    name = str(payload.get("name", "")).strip()
    email = str(payload.get("email", "")).strip().lower()
    age_group = str(payload.get("ageGroup", ""))
    marital_status = str(payload.get("maritalStatus", ""))
    contact = str(payload.get("contact", "")).strip()
    group = str(payload.get("group", "General")).strip()
    if len(name) < 2 or len(email) > 180 or age_group not in MEMBER_AGE_GROUPS or (marital_status and marital_status not in MARITAL_STATUSES) or len(contact) > 30 or len(group) > 80:
        raise HTTPException(status_code=400, detail="Enter a valid member name, age group, marital status, contact, email, and ministry.")
    created = {
        "name": name,
        "email": email,
        "ageGroup": age_group,
        "maritalStatus": marital_status,
        "contact": contact,
        "group": group,
        "status": "Active",
        "joined": datetime.now(timezone.utc),
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }
    result = get_db().members.insert_one(created)
    created["_id"] = result.inserted_id
    return serialize_value(created)


@app.get("/api/dues")
async def list_dues(request: Request) -> list[dict[str, Any]]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Financial Secretary", "Treasurer", "Member"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    if user.get("role") == "Member":
        if not user.get("memberId"):
            raise HTTPException(status_code=403, detail="This member login is not linked to a church member record.")
        rows = list(get_db().dues.find({"memberId": ObjectId(user["memberId"])}).sort("month", -1))
    else:
        rows = list(get_db().dues.find().sort([("month", -1), ("memberName", 1)]))
    output = []
    for item in rows:
        output.append({
            "id": str(item["_id"]),
            "memberId": str(item["memberId"]),
            "memberName": item.get("memberName"),
            "month": item.get("month") or None,
            "expectedDues": float(item.get("expectedDues") or 0),
            "amountPaid": float(item.get("amountPaid") or 0),
            "status": item.get("status"),
            "lastPaid": item.get("lastPaid"),
            "createdAt": item.get("createdAt"),
        })
    return output


@app.post("/api/dues")
async def create_due(request: Request) -> dict[str, Any]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Financial Secretary", "Treasurer"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    payload = await request.json()
    member_id = str(payload.get("memberId", "")).strip()
    amount_paid = float(payload.get("amountPaid", 0) or 0)
    month = str(payload.get("month") or datetime.now(timezone.utc).strftime("%Y-%m")).strip()
    if not ObjectId.is_valid(member_id) or not isinstance(amount_paid, (int, float)) or amount_paid < 0 or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise HTTPException(status_code=400, detail="Enter a valid member, month, and dues amount.")
    member = get_db().members.find_one({"_id": ObjectId(member_id)})
    if not member:
        raise HTTPException(status_code=404, detail="Member not found.")
    expected_dues = member_dues_amount(member)
    due = get_db().dues.find_one({"memberId": ObjectId(member_id), "month": month})
    now = datetime.now(timezone.utc)
    if not due:
        due = {
            "memberId": ObjectId(member_id),
            "memberName": member["name"],
            "month": month,
            "expectedDues": expected_dues,
            "amountPaid": amount_paid,
            "status": "Paid" if amount_paid >= expected_dues else "Partial" if amount_paid > 0 else "Owing",
            "lastPaid": now if amount_paid > 0 else None,
            "recordedBy": ObjectId(user["_id"]),
            "createdAt": now,
            "updatedAt": now,
        }
        inserted = get_db().dues.insert_one(due)
        due["_id"] = inserted.inserted_id
    else:
        new_amount = float(due.get("amountPaid") or 0) + amount_paid
        update = {
            "memberName": member["name"],
            "expectedDues": expected_dues,
            "amountPaid": new_amount,
            "status": "Paid" if new_amount >= expected_dues else "Partial" if new_amount > 0 else "Owing",
            "lastPaid": now if amount_paid > 0 else due.get("lastPaid"),
            "recordedBy": ObjectId(user["_id"]),
            "updatedAt": now,
        }
        get_db().dues.update_one({"_id": due["_id"]}, {"$set": update})
        due.update(update)
    return {
        "id": str(due["_id"]),
        "memberId": str(due["memberId"]),
        "memberName": due["memberName"],
        "month": due.get("month") or None,
        "expectedDues": float(due.get("expectedDues") or 0),
        "amountPaid": float(due.get("amountPaid") or 0),
        "status": due.get("status"),
        "lastPaid": due.get("lastPaid"),
    }


@app.get("/api/attendance")
async def list_attendance(request: Request) -> list[dict[str, Any]]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Secretary"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    rows = list(get_db().attendance.find().sort([("date", -1), ("createdAt", -1)]).limit(250))
    return serialize_value(rows)


@app.post("/api/attendance")
async def create_attendance(request: Request) -> dict[str, Any]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Secretary"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    payload = await request.json()
    date_value = payload.get("date")
    count = int(payload.get("count", 0) or 0)
    service = str(payload.get("service", "")).strip()
    try:
        date_obj = datetime.fromisoformat(date_value.replace("Z", "+00:00")) if isinstance(date_value, str) else datetime.now(timezone.utc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Enter a valid date, service, and attendance count.") from exc
    if not isinstance(count, int) or count < 0 or count > 100000 or not service or len(service) > 100:
        raise HTTPException(status_code=400, detail="Enter a valid date, service, and attendance count.")
    inserted = {
        "date": date_obj,
        "service": service,
        "count": count,
        "recordedBy": ObjectId(user["_id"]),
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }
    result = get_db().attendance.insert_one(inserted)
    inserted["_id"] = result.inserted_id
    return serialize_value(inserted)


@app.get("/api/announcements")
async def list_announcements(request: Request) -> list[dict[str, Any]]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Secretary"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    rows = list(get_db().announcements.find().sort("createdAt", -1).limit(100))
    return serialize_value(rows)


@app.post("/api/announcements")
async def create_announcement(request: Request) -> dict[str, Any]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Secretary"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    payload = await request.json()
    title = str(payload.get("title", "")).strip()
    body = str(payload.get("body", "")).strip()
    audience = str(payload.get("audience", "All members")).strip()
    if not title or len(title) > 90 or not body or len(body) > 600 or not audience or len(audience) > 80:
        raise HTTPException(status_code=400, detail="Enter a title, message, and audience within the allowed lengths.")
    inserted = {
        "title": title,
        "body": body,
        "audience": audience,
        "publishedBy": ObjectId(user["_id"]),
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }
    result = get_db().announcements.insert_one(inserted)
    inserted["_id"] = result.inserted_id
    return serialize_value(inserted)


@app.get("/api/events")
async def list_events(request: Request) -> list[dict[str, Any]]:
    await get_authenticated_user(request)
    rows = list(get_db().events.find().sort("date", 1).limit(500))
    return serialize_value(rows)


@app.post("/api/events")
async def create_event(request: Request) -> dict[str, Any]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Secretary"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    payload = await request.json()
    title = str(payload.get("title", "")).strip()
    date_value = payload.get("date")
    time_value = str(payload.get("time", "")).strip()
    location = str(payload.get("location", "")).strip()
    try:
        date_obj = datetime.fromisoformat(str(date_value).replace("Z", "+00:00")) if isinstance(date_value, str) else datetime.now(timezone.utc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Enter a valid event title, date, time, and location.") from exc
    if not title or len(title) > 120 or not time_value or len(time_value) > 30 or not location or len(location) > 120:
        raise HTTPException(status_code=400, detail="Enter a valid event title, date, time, and location.")
    inserted = {
        "title": title,
        "date": date_obj,
        "time": time_value,
        "location": location,
        "createdBy": ObjectId(user["_id"]),
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }
    result = get_db().events.insert_one(inserted)
    inserted["_id"] = result.inserted_id
    return serialize_value(inserted)


@app.get("/api/transactions")
async def list_transactions(request: Request) -> list[dict[str, Any]]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Financial Secretary", "Treasurer"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    rows = list(get_db().transactions.find().sort("date", -1).limit(250))
    return serialize_value(rows)


@app.post("/api/transactions")
async def create_transaction(request: Request) -> dict[str, Any]:
    user = await get_authenticated_user(request)
    if user.get("role") not in {"Admin", "Financial Secretary", "Treasurer"}:
        raise HTTPException(status_code=403, detail="You do not have permission to do that.")
    payload = await request.json()
    title = str(payload.get("title", "")).strip()
    category = str(payload.get("category", "")).strip()
    date_value = payload.get("date")
    amount = float(payload.get("amount", 0) or 0)
    direction = str(payload.get("direction", ""))
    try:
        date_obj = datetime.fromisoformat(str(date_value).replace("Z", "+00:00")) if isinstance(date_value, str) else datetime.now(timezone.utc)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Enter valid transaction details and a positive amount.") from exc
    if not title or len(title) > 120 or not category or len(category) > 80 or not isinstance(amount, (int, float)) or amount <= 0 or direction not in {"Income", "Expense"}:
        raise HTTPException(status_code=400, detail="Enter valid transaction details and a positive amount.")
    inserted = {
        "title": title,
        "category": category,
        "date": date_obj,
        "amount": amount,
        "direction": direction,
        "status": "Received" if direction == "Income" else "Pending",
        "recordedBy": ObjectId(user["_id"]),
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }
    result = get_db().transactions.insert_one(inserted)
    inserted["_id"] = result.inserted_id
    return serialize_value(inserted)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail}, headers=exc.headers)


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    if isinstance(exc, DuplicateKeyError):
        return JSONResponse(status_code=409, content={"error": "That username or email address is already in use."})
    if "Validation" in exc.__class__.__name__ or "Cast" in exc.__class__.__name__:
        return JSONResponse(status_code=400, content={"error": "Some submitted data is invalid."})
    logging.getLogger(__name__).exception("Unexpected application error", exc_info=exc)
    return JSONResponse(status_code=500, content={"error": "An unexpected server error occurred."})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)
