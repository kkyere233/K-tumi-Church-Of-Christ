require("dotenv").config();

const readline = require("node:readline");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
  username: String,
  passwordHash: String,
  role: String
}, { timestamps: true });
const User = mongoose.model("User", userSchema);

function ask(question) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => terminal.question(question, answer => {
    terminal.close();
    resolve(answer.trim());
  }));
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      reject(new Error("Run this command directly in an interactive terminal."));
      return;
    }

    let password = "";
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();

    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      process.stdout.write("\n");
    };
    const onData = key => {
      for (const character of key.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Password reset cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(password);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          password = password.slice(0, -1);
        } else if (character >= " " && character <= "~") {
          password += character;
        }
      }
    };

    input.on("data", onData);
  });
}

async function resetAdminPassword() {
  if (!process.env.MONGODB_URI) throw new Error("Set MONGODB_URI in your .env file.");

  const username = await ask("Admin username: ");
  if (!username) throw new Error("Enter the username of an existing Admin account.");

  await mongoose.connect(process.env.MONGODB_URI);
  const admin = await User.findOne({ username: username.toLowerCase(), role: "Admin" }).select("_id username").lean();
  if (!admin) throw new Error("No Admin account was found with that username.");

  const password = await askHidden("New password (hidden): ");
  if (password.length < 8) throw new Error("The password must contain at least 8 characters.");
  if (password !== await askHidden("Confirm new password (hidden): ")) throw new Error("The passwords do not match.");

  await User.updateOne({ _id: admin._id, role: "Admin" }, { $set: { passwordHash: await bcrypt.hash(password, 12) } });
  console.log(`Password updated for Admin account ${admin.username}.`);
}

resetAdminPassword()
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());