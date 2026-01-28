import { execSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).map((x) => {
    const [k, v] = x.split("=");
    return [k.replace(/^--/, ""), v ?? true];
  })
);

const base = args.base;
const head = args.head;
const dir = args.dir || "schemas";

if (!base || !head) {
  console.error("Usage: node eventdiff.mjs --base=<sha> --head=<sha> [--dir=schemas]");
  process.exit(2);
}

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGitShow(ref, path) {
  try {
    const content = sh(`git show ${ref}:${path}`);
    return { ok: true, content };
  } catch {
    return { ok: false, content: null };
  }
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function isObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function normalizeType(t) {
  if (Array.isArray(t)) {
    const set = new Set(t);
    const nullable = set.has("null");
    set.delete("null");
    const rest = Array.from(set).sort();
    return { type: rest.length === 1 ? rest[0] : rest.length ? rest.join("|") : "unknown", nullable };
  }
  if (typeof t === "string") return { type: t, nullable: false };
  return { type: "unknown", nullable: false };
}

function flatten(schema) {
  const fields = new Map();

  const walk = (node, path, requiredNames) => {
    if (!node) return;
    const t = normalizeType(node.type);
    const req = requiredNames?.has(path) ?? false;

    if (path) {
      fields.set(path, {
        path,
        type: t.type,
        nullable: t.nullable,
        required: req,
        enum: Array.isArray(node.enum) ? node.enum.slice() : null,
      });
    }

    const props = node.properties;
    const required = Array.isArray(node.required) ? node.required : [];
    if (isObject(props)) {
      const childReq = new Set();
      for (const r of required) {
        if (typeof r === "string") childReq.add(path ? `${path}.${r}` : r);
      }
      for (const [k, v] of Object.entries(props)) {
        walk(v, path ? `${path}.${k}` : k, childReq);
      }
    }
  };

  walk(schema, "", new Set());
  return fields;
}

function enumDiff(oldEnum, newEnum) {
  const a = new Set(oldEnum || []);
  const b = new Set(newEnum || []);
  const removed = [];
  const added = [];
  for (const v of a) if (!b.has(v)) removed.push(v);
  for (const v of b) if (!a.has(v)) added.push(v);
  removed.sort();
  added.sort();
  return { removed, added };
}

function diff(oldSchema, newSchema) {
  const A = flatten(oldSchema);
  const B = flatten(newSchema);
  const paths = new Set([...A.keys(), ...B.keys()]);
  const changes = [];

  for (const path of Array.from(paths).sort()) {
    const a = A.get(path);
    const b = B.get(path);

    if (a && !b) {
      changes.push({
        severity: a.required ? "block" : "warn",
        kind: "FIELD_REMOVED",
        path,
        message: a.required ? `Removed required field '${path}'.` : `Removed optional field '${path}'.`,
      });
      continue;
    }

    if (!a && b) {
      changes.push({
        severity: b.required ? "block" : "pass",
        kind: "FIELD_ADDED",
        path,
        message: b.required ? `Added required field '${path}'.` : `Added optional field '${path}'.`,
      });
      continue;
    }

    if (!a || !b) continue;

    if (a.required !== b.required) {
      changes.push({
        severity: !a.required && b.required ? "block" : "warn",
        kind: "REQUIRED_CHANGED",
        path,
        message: !a.required && b.required
          ? `Optional → required: '${path}'.`
          : `Required → optional: '${path}'.`,
      });
    }

    if (a.type !== b.type || a.nullable !== b.nullable) {
      changes.push({
        severity: "block",
        kind: "TYPE_CHANGED",
        path,
        message: `Type changed '${path}': ${a.type}${a.nullable ? " (nullable)" : ""} → ${b.type}${b.nullable ? " (nullable)" : ""}`,
      });
    }

    const ed = enumDiff(a.enum, b.enum);
    if (ed.removed.length) {
      changes.push({
        severity: "block",
        kind: "ENUM_VALUE_REMOVED",
        path,
        message: `Enum removed from '${path}': ${ed.removed.join(", ")}`,
      });
    }
    if (ed.added.length) {
      changes.push({
        severity: "pass",
        kind: "ENUM_VALUE_ADDED",
        path,
        message: `Enum added to '${path}': ${ed.added.join(", ")}`,
      });
    }
  }

  const blocks = changes.filter((c) => c.severity === "block").length;
  const warns = changes.filter((c) => c.severity === "warn").length;
  const passes = changes.filter((c) => c.severity === "pass").length;

  return {
    summary: { decision: blocks > 0 ? "FAIL" : "PASS", blocks, warns, passes },
    changes,
  };
}

const changed = sh(`git diff --name-only ${base} ${head} -- ${dir}`)
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

if (changed.length === 0) {
  console.log(JSON.stringify({ summary: { decision: "PASS", blocks: 0, warns: 0, passes: 0 }, changes: [] }, null, 2));
  process.exit(0);
}

const reports = [];
let anyBlock = false;

for (const path of changed) {
  const oldFile = tryGitShow(base, path);
  const newFile = tryGitShow(head, path);

  if (!oldFile.ok && newFile.ok) {
    reports.push({
      file: path,
      summary: { decision: "PASS", blocks: 0, warns: 0, passes: 1 },
      changes: [{ severity: "pass", kind: "FILE_ADDED", path, message: `Schema file added: ${path}` }],
    });
    continue;
  }
  if (oldFile.ok && !newFile.ok) {
    reports.push({
      file: path,
      summary: { decision: "FAIL", blocks: 1, warns: 0, passes: 0 },
      changes: [{ severity: "block", kind: "FILE_REMOVED", path, message: `Schema file removed: ${path}` }],
    });
    anyBlock = true;
    continue;
  }

  const oldParsed = safeJsonParse(oldFile.content);
  const newParsed = safeJsonParse(newFile.content);

  if (!oldParsed.ok || !newParsed.ok) {
    reports.push({
      file: path,
      summary: { decision: "FAIL", blocks: 1, warns: 0, passes: 0 },
      changes: [{
        severity: "block",
        kind: "INVALID_JSON",
        path,
        message: `Invalid JSON in ${!oldParsed.ok ? "base" : "head"} version of ${path}.`,
      }],
    });
    anyBlock = true;
    continue;
  }

  const r = diff(oldParsed.value, newParsed.value);
  reports.push({ file: path, ...r });
  if (r.summary.blocks > 0) anyBlock = true;
}

const final = {
  base,
  head,
  dir,
  summary: {
    decision: anyBlock ? "FAIL" : "PASS",
    blocks: reports.reduce((a, r) => a + r.summary.blocks, 0),
    warns: reports.reduce((a, r) => a + r.summary.warns, 0),
    passes: reports.reduce((a, r) => a + r.summary.passes, 0),
  },
  reports,
};

console.log(JSON.stringify(final, null, 2));
process.exit(anyBlock ? 1 : 0);
