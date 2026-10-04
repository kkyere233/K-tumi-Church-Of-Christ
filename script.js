require("dotenv").config();

const path = require("node:path");
const os = require("node:os");
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const port = Number(process.env.PORT || 3000);
const roles = ["Admin", "Secretary", "Financial Secretary", "Treasurer", "Member"];
const maritalStatuses = ["Single", "Married", "Divorced", "Widowed", "Prefer not to say"];
const memberAgeGroups = ["Below 20", "20 or above"];
const legacyMemberAgeGroups = ["20 or under", "Over 20"];
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, sparse: true, lowercase: true, trim: true, maxlength: 32 },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, required: true, enum: roles },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", default: null },
  active: { type: Boolean, default: true }
}, { timestamps: true });
const memberSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, trim: true, lowercase: true, maxlength: 180, default: "" },
  age: { type: Number, min: 0, max: 120, default: null },
  ageGroup: { type: String, enum: [...memberAgeGroups, ...legacyMemberAgeGroups, ""], default: "" },
  maritalStatus: { type: String, enum: [...maritalStatuses, ""], default: "" },
  contact: { type: String, trim: true, maxlength: 30, default: "" },
  group: { type: String, trim: true, maxlength: 80, default: "General" },
  status: { type: String, enum: ["Active", "Pending", "Inactive"], default: "Active" },
  joined: { type: Date, default: Date.now }
}, { timestamps: true });
const attendanceSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  service: { type: String, required: true, trim: true, maxlength: 100 },
  count: { type: Number, required: true, min: 0, max: 100000 },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });
const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 90 },
  body: { type: String, required: true, trim: true, maxlength: 600 },
  audience: { type: String, required: true, trim: true, maxlength: 80 },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });
const eventSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  date: { type: Date, required: true },
  time: { type: String, required: true, trim: true, maxlength: 30 },
  location: { type: String, required: true, trim: true, maxlength: 120 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });
const transactionSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  category: { type: String, required: true, trim: true, maxlength: 80 },
  date: { type: Date, required: true },
  amount: { type: Number, required: true, min: 0 },
  direction: { type: String, required: true, enum: ["Income", "Expense"] },
  status: { type: String, enum: ["Received", "Approved", "Pending"], default: "Received" },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });
const dueSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
  memberName: { type: String, required: true, trim: true, maxlength: 100 },
  month: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  expectedDues: { type: Number, required: true, min: 0, default: 20 },
  amountPaid: { type: Number, required: true, min: 0, default: 0 },
  status: { type: String, required: true, enum: ["Paid", "Partial", "Owing"], default: "Owing" },
  lastPaid: { type: Date, default: null },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const Member = mongoose.model("Member", memberSchema);
const Attendance = mongoose.model("Attendance", attendanceSchema);
const Announcement = mongoose.model("Announcement", announcementSchema);
const Event = mongoose.model("Event", eventSchema);
const Transaction = mongoose.model("Transaction", transactionSchema);
const Due = mongoose.model("Due", dueSchema);

function memberDuesAmount(member) {
  return memberAgeGroup(member) === "Below 20" ? 10 : 20;
}

function memberAgeGroup(member) {
  if (Number.isInteger(member.age)) return member.age < 20 ? "Below 20" : "20 or above";
  if (member.ageGroup === "20 or under") return "Below 20";
  if (member.ageGroup === "Over 20") return "20 or above";
  return member.ageGroup || "";
}

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"],
    formAction: ["'self'"], frameAncestors: ["'none'"]
  } }
}));
app.use(express.json({ limit: "32kb" }));
app.use(session({
  name: "church-office.sid",
  secret: process.env.SESSION_SECRET || "missing-session-secret",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/church_office", collectionName: "sessions" }),
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));

function safeUser(user) {
  return { id: user.id, username: user.username, name: user.name, email: user.email, role: user.role, memberId: user.memberId ? String(user.memberId) : null };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function requireAuth(req, res, next) {
  try {
    if (!req.session.userId) return res.status(401).json({ error: "Please sign in." });
    const user = await User.findById(req.session.userId);
    if (!user || !user.active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: "Your account is inactive. Sign in with an active account." });
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function allowRoles(...allowedRoles) {
  return (req, res, next) => req.user && allowedRoles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: "You do not have permission to do that." });
}

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "Request origin is not allowed." });
    } catch {
      return res.status(403).json({ error: "Invalid request origin." });
    }
  }
  next();
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/dashboard", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "COC jct.html")));
app.get("/assets/church-logo.svg", (req, res) => res.sendFile(path.join(__dirname, "assets", "church-logo.svg")));
app.get("/assets/church-logo-dark.svg", (req, res) => res.sendFile(path.join(__dirname, "assets", "church-logo-dark.svg")));
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api", requireSameOrigin);

app.post("/api/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false }), asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!username || !password || password.length > 200) return res.status(400).json({ error: "Enter your username and password." });
  const user = await User.findOne({ $or: [{ username }, { email: username }] });
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "Username or password is incorrect." });
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.userId = user.id;
  res.json({ user: safeUser(user) });
}));

app.post("/api/auth/logout", requireAuth, asyncRoute(async (req, res) => {
  await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
  res.clearCookie("church-office.sid", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production" });
  res.status(204).end();
}));
app.get("/api/auth/me", requireAuth, asyncRoute(async (req, res) => {
  const user = safeUser(req.user);
  if (req.user.role === "Member" && req.user.memberId) {
    const member = await Member.findById(req.user.memberId).select("age ageGroup");
    if (member) {
      user.ageGroup = memberAgeGroup(member) || "20 or above";
      user.monthlyDues = memberDuesAmount(member);
    }
  }
  res.json({ user });
}));

app.get("/api/users", requireAuth, allowRoles("Admin"), asyncRoute(async (req, res) => {
  const users = await User.find().select("username name email role memberId active createdAt").sort({ name: 1 }).lean();
  res.json(users.map(user => ({ ...user, id: String(user._id) })));
}));
app.post("/api/users", requireAuth, allowRoles("Admin"), asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "");
  const ageGroup = String(req.body.ageGroup || "");
  if (!/^[a-z0-9._-]{3,32}$/.test(username) || name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || !roles.includes(role)) return res.status(400).json({ error: "Provide a valid username, name, email, role, and password of at least 8 characters." });
  let linkedMember = null;
  if (role === "Member") {
    if (!memberAgeGroups.includes(ageGroup)) return res.status(400).json({ error: "Select whether the member is below 20 or 20 or above." });
    linkedMember = await Member.findOne({ email });
    if (!linkedMember) return res.status(404).json({ error: "No directory member matches this email address. Add the member with this email first." });
    if (await User.exists({ memberId: linkedMember._id })) return res.status(409).json({ error: "A login is already linked to that member." });
    if (memberAgeGroup(linkedMember) && memberAgeGroup(linkedMember) !== ageGroup) {
      return res.status(400).json({ error: "The selected age group does not match the member's age group in the directory." });
    }
  }
  const user = await User.create({
    username, name, email, passwordHash: await bcrypt.hash(password, 12), role,
    memberId: linkedMember ? linkedMember._id : null
  });
  if (linkedMember) {
    try {
      linkedMember.ageGroup = ageGroup;
      await linkedMember.save();
    } catch (error) {
      await User.deleteOne({ _id: user._id });
      throw error;
    }
  }
  res.status(201).json(safeUser(user));
}));
app.patch("/api/users/:id", requireAuth, allowRoles("Admin"), asyncRoute(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User account not found." });
  if (String(user._id) === String(req.user._id)) return res.status(400).json({ error: "You cannot change your own account here." });
  if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "Provide an active status." });
  if (!req.body.active && user.role === "Admin" && await User.countDocuments({ role: "Admin", active: true }) <= 1) return res.status(400).json({ error: "The last active Admin cannot be disabled." });
  user.active = req.body.active;
  await user.save();
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, active: user.active });
}));

app.get("/api/members", requireAuth, allowRoles("Admin", "Secretary", "Financial Secretary", "Treasurer"), asyncRoute(async (req, res) => {
  const members = await Member.find().sort({ name: 1 }).lean();
  const membersWithDues = members.map(member => ({ ...member, ageGroup: memberAgeGroup(member), monthlyDues: memberDuesAmount(member) }));
  if (req.user.role !== "Admin" && req.user.role !== "Secretary") {
    return res.json(membersWithDues.map(({ age, ageGroup, maritalStatus, contact, ...member }) => member));
  }
  res.json(membersWithDues.map(({ age, ...member }) => member));
}));
app.post("/api/members", requireAuth, allowRoles("Admin", "Secretary"), asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const ageGroup = String(req.body.ageGroup || "");
  const maritalStatus = String(req.body.maritalStatus || "");
  const contact = String(req.body.contact || "").trim();
  const group = String(req.body.group || "General").trim();
  if (name.length < 2 || email.length > 180 || !memberAgeGroups.includes(ageGroup) || (maritalStatus !== "" && !maritalStatuses.includes(maritalStatus)) || contact.length > 30 || group.length > 80) {
    return res.status(400).json({ error: "Enter a valid member name, age group, marital status, contact, email, and ministry." });
  }
  res.status(201).json(await Member.create({ name, email, ageGroup, maritalStatus, contact, group }));
}));

app.get("/api/dues", requireAuth, allowRoles("Admin", "Financial Secretary", "Treasurer", "Member"), asyncRoute(async (req, res) => {
  if (req.user.role === "Member" && !req.user.memberId) return res.status(403).json({ error: "This member login is not linked to a church member record." });
  const filter = req.user.role === "Member" ? { memberId: req.user.memberId } : {};
  const dues = await Due.find(filter).sort({ month: -1, memberName: 1 }).lean();
  res.json(dues.map(item => ({
    id: String(item._id),
    memberId: String(item.memberId),
    memberName: item.memberName,
    month: item.month || null,
    expectedDues: Number(item.expectedDues || 0),
    amountPaid: Number(item.amountPaid || 0),
    status: item.status,
    lastPaid: item.lastPaid,
    createdAt: item.createdAt
  })));
}));
app.post("/api/dues", requireAuth, allowRoles("Admin", "Financial Secretary", "Treasurer"), asyncRoute(async (req, res) => {
  const memberId = String(req.body.memberId || "").trim();
  const amountPaid = Number(req.body.amountPaid);
  const month = String(req.body.month || new Date().toISOString().slice(0, 7)).trim();
  if (!mongoose.Types.ObjectId.isValid(memberId) || !Number.isFinite(amountPaid) || amountPaid < 0 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({ error: "Enter a valid member, month, and dues amount." });
  }
  const member = await Member.findById(memberId);
  if (!member) return res.status(404).json({ error: "Member not found." });
  const expectedDues = memberDuesAmount(member);
  let due = await Due.findOne({ memberId, month });
  if (!due) {
    due = new Due({ memberId, memberName: member.name, month, expectedDues, amountPaid, status: "Owing", lastPaid: amountPaid > 0 ? new Date() : null, recordedBy: req.user._id });
  } else {
    due.memberName = member.name;
    due.expectedDues = expectedDues;
    due.amountPaid = Number(due.amountPaid) + amountPaid;
    if (amountPaid > 0) due.lastPaid = new Date();
    due.recordedBy = req.user._id;
  }
  due.status = due.amountPaid >= due.expectedDues ? "Paid" : due.amountPaid > 0 ? "Partial" : "Owing";
  await due.save();
  res.status(201).json({
    id: String(due._id),
    memberId: String(due.memberId),
    memberName: due.memberName,
    month: due.month || null,
    expectedDues: Number(due.expectedDues),
    amountPaid: Number(due.amountPaid),
    status: due.status,
    lastPaid: due.lastPaid
  });
}));

app.get("/api/attendance", requireAuth, allowRoles("Admin", "Secretary"), asyncRoute(async (req, res) => res.json(await Attendance.find().sort({ date: -1, createdAt: -1 }).limit(250).lean())));
app.post("/api/attendance", requireAuth, allowRoles("Admin", "Secretary"), asyncRoute(async (req, res) => {
  const date = new Date(req.body.date);
  const count = Number(req.body.count);
  const service = String(req.body.service || "").trim();
  if (!Number.isFinite(date.getTime()) || !Number.isInteger(count) || count < 0 || count > 100000 || !service || service.length > 100) return res.status(400).json({ error: "Enter a valid date, service, and attendance count." });
  res.status(201).json(await Attendance.create({ date, count, service, recordedBy: req.user._id }));
}));

app.get("/api/announcements", requireAuth, allowRoles("Admin", "Secretary"), asyncRoute(async (req, res) => res.json(await Announcement.find().sort({ createdAt: -1 }).limit(100).lean())));
app.post("/api/announcements", requireAuth, allowRoles("Admin", "Secretary"), asyncRoute(async (req, res) => {
  const title = String(req.body.title || "").trim();
  const body = String(req.body.body || "").trim();
  const audience = String(req.body.audience || "All members").trim();
  if (!title || title.length > 90 || !body || body.length > 600 || !audience || audience.length > 80) return res.status(400).json({ error: "Enter a title, message, and audience within the allowed lengths." });
  res.status(201).json(await Announcement.create({ title, body, audience, publishedBy: req.user._id }));
}));

app.get("/api/events", requireAuth, asyncRoute(async (req, res) => res.json(await Event.find().sort({ date: 1 }).limit(500).lean())));
app.post("/api/events", requireAuth, allowRoles("Admin", "Secretary"), asyncRoute(async (req, res) => {
  const title = String(req.body.title || "").trim();
  const date = new Date(req.body.date);
  const time = String(req.body.time || "").trim();
  const location = String(req.body.location || "").trim();
  if (!title || title.length > 120 || !Number.isFinite(date.getTime()) || !time || time.length > 30 || !location || location.length > 120) return res.status(400).json({ error: "Enter a valid event title, date, time, and location." });
  res.status(201).json(await Event.create({ title, date, time, location, createdBy: req.user._id }));
}));

app.get("/api/transactions", requireAuth, allowRoles("Admin", "Financial Secretary", "Treasurer"), asyncRoute(async (req, res) => res.json(await Transaction.find().sort({ date: -1 }).limit(250).lean())));
app.post("/api/transactions", requireAuth, allowRoles("Admin", "Financial Secretary", "Treasurer"), asyncRoute(async (req, res) => {
  const title = String(req.body.title || "").trim();
  const category = String(req.body.category || "").trim();
  const date = new Date(req.body.date);
  const amount = Number(req.body.amount);
  const direction = String(req.body.direction || "");
  if (!title || title.length > 120 || !category || category.length > 80 || !Number.isFinite(date.getTime()) || !Number.isFinite(amount) || amount <= 0 || !["Income", "Expense"].includes(direction)) return res.status(400).json({ error: "Enter valid transaction details and a positive amount." });
  res.status(201).json(await Transaction.create({ title, category, date, amount, direction, status: direction === "Income" ? "Received" : "Pending", recordedBy: req.user._id }));
}));

app.use((req, res) => res.status(404).json({ error: "Not found." }));
app.use((error, req, res, next) => {
  if (error && error.code === 11000) return res.status(409).json({ error: "That username or email address is already in use." });
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) return res.status(400).json({ error: "Some submitted data is invalid." });
  console.error(error);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

async function start() {
  if (!process.env.MONGODB_URI) throw new Error("Set MONGODB_URI in your .env file.");
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  await mongoose.connect(process.env.MONGODB_URI);
  const usersWithoutUsernames = await User.find({ $or: [{ username: { $exists: false } }, { username: "" }] }).select("_id email").sort({ _id: 1 }).lean();
  for (const user of usersWithoutUsernames) {
    const emailPrefix = user.email.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "");
    const base = (emailPrefix.length >= 3 ? emailPrefix : `user_${String(user._id).slice(-6)}`).slice(0, 32);
    let username = base;
    let suffix = 1;
    while (await User.exists({ username })) {
      const suffixText = `_${suffix++}`;
      username = `${base.slice(0, 32 - suffixText.length)}${suffixText}`;
    }
    await User.updateOne({ _id: user._id }, { $set: { username } });
  }
  if (!await User.exists({ role: "Admin" })) {
    const name = String(process.env.BOOTSTRAP_ADMIN_NAME || "").trim();
    const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
    const username = String(process.env.BOOTSTRAP_ADMIN_USERNAME || email.split("@")[0]).trim().toLowerCase();
    const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || "");
    if (!/^[a-z0-9._-]{3,32}$/.test(username) || name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) throw new Error("Set BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL, and a BOOTSTRAP_ADMIN_PASSWORD of at least 8 characters for the first Admin.");
    await User.create({ username, name, email, passwordHash: await bcrypt.hash(password, 12), role: "Admin" });
    console.log(`Created initial Admin account for ${email}.`);
  }
  app.listen(port, "0.0.0.0", () => {
    console.log(`Kukurantumi Church Of Christ Youth is available at http://localhost:${port}`);
    const lanAddresses = [...new Set(Object.values(os.networkInterfaces())
      .flatMap(addresses => (addresses || [])
        .filter(address => !address.internal && (address.family === "IPv4" || address.family === 4))
        .map(address => address.address)))];
    for (const address of lanAddresses) {
      console.log(`Same-network access: http://${address}:${port}`);
    }
  });
}

if (require.main === module) start().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { app, start };
