const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const uri = "mongodb://127.0.0.1:27017/church_office";
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, sparse: true, lowercase: true, trim: true, maxlength: 32 },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, required: true, enum: ["Admin", "Secretary", "Financial Secretary", "Treasurer"] },
  active: { type: Boolean, default: true }
}, { timestamps: true });
const User = mongoose.models.User || mongoose.model("User", userSchema);
(async () => {
  await mongoose.connect(uri);
  const username = "yawkyere";
  const email = "yawkyere@example.com";
  const existing = await User.findOne({ $or: [{ username }, { email }] });
  if (existing) {
    console.log(JSON.stringify({ status: "exists", username: existing.username, email: existing.email, role: existing.role }));
    await mongoose.disconnect();
    return;
  }
  const hash = await bcrypt.hash("Hotnnnote1", 12);
  const doc = await User.create({ username, name: "Yaw Kyere", email, passwordHash: hash, role: "Admin", active: true });
  console.log(JSON.stringify({ status: "created", username: doc.username, email: doc.email, role: doc.role }));
  await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
