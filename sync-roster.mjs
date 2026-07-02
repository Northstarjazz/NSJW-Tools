#!/usr/bin/env node
/*
 * NSJW Ensemble Builder — roster sync
 * Pulls active ensemble members + Qualified/Sit-In (Trial) leads from Monday
 * and writes roster.json (the file the tool reads). Runs in GitHub Actions daily.
 * Requires env MONDAY_TOKEN.
 */
import { writeFileSync } from "node:fs";

const TOKEN = process.env.MONDAY_TOKEN;
if (!TOKEN) { console.error("Missing MONDAY_TOKEN env var"); process.exit(1); }

const MEMBERS_BOARD = 9110939801;
const MEMBERS_GROUP = "group_mkqwrm86";            // "North Star Ensemble Members"
const LEADS_BOARD   = 9110939764;
const COL = {
  m_instr: "dropdown_mm0x8drd", m_belt: "dropdown_mm0w5pn9", m_band: "color_mkqwqaav",
  m_left: "date_mkrv4bc2", m_returned: "date_mm35fgf3",
  l_status: "lead_status", l_instr: "dropdown_mm0x60f5", l_program: "dropdown_mm0w5a2",
};

async function gql(query) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: TOKEN, "API-Version": "2024-10" },
    body: JSON.stringify({ query }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const val = (item, id) => {
  const cv = item.column_values.find(c => c.id === id);
  return cv && cv.text ? cv.text : "";
};

function cleanInstrument(s) {
  if (!s) return "";
  const toks = String(s).split(/[,/]| & /).map(t => t.trim()).filter(Boolean);
  const out = [];
  for (const t of toks) {
    if (t.toLowerCase() === "please input") continue;
    if (!out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.join(", ");
}

// ---- paginate a group's items ----
async function groupItems(boardId, groupId) {
  let data = await gql(`{ boards(ids:${boardId}){ groups(ids:["${groupId}"]){ items_page(limit:200){ cursor items{ id name column_values(ids:["${COL.m_instr}","${COL.m_belt}","${COL.m_band}","${COL.m_left}","${COL.m_returned}"]){ id text } } } } } }`);
  let page = data.boards[0].groups[0].items_page;
  let items = page.items;
  while (page.cursor) {
    data = await gql(`{ next_items_page(limit:200, cursor:"${page.cursor}"){ cursor items{ id name column_values(ids:["${COL.m_instr}","${COL.m_belt}","${COL.m_band}","${COL.m_left}","${COL.m_returned}"]){ id text } } } }`);
    page = data.next_items_page;
    items = items.concat(page.items);
  }
  return items;
}

// ---- paginate a whole board's items ----
async function boardItems(boardId) {
  let data = await gql(`{ boards(ids:${boardId}){ items_page(limit:200){ cursor items{ id name column_values(ids:["${COL.l_status}","${COL.l_instr}","${COL.l_program}"]){ id text } } } } }`);
  let page = data.boards[0].items_page;
  let items = page.items;
  while (page.cursor) {
    data = await gql(`{ next_items_page(limit:200, cursor:"${page.cursor}"){ cursor items{ id name column_values(ids:["${COL.l_status}","${COL.l_instr}","${COL.l_program}"]){ id text } } } }`);
    page = data.next_items_page;
    items = items.concat(page.items);
  }
  return items;
}

const bandNum = b => { const n = parseInt(String(b).replace(/\D/g, "")); return isNaN(n) ? 999 : n; };

async function main() {
  // MEMBERS — active ensemble group, keep only those assigned to a "Group N" band
  const rawMembers = await groupItems(MEMBERS_BOARD, MEMBERS_GROUP);
  const members = rawMembers
    .filter(it => /^Group\s/.test(val(it, COL.m_band)))
    .map(it => ({
      id: it.id, name: it.name, band: val(it, COL.m_band),
      instrument: cleanInstrument(val(it, COL.m_instr)), belt: val(it, COL.m_belt),
      left: (val(it, COL.m_left) || "").split(" ")[0],
      returned: (val(it, COL.m_returned) || "").split(" ")[0],
    }))
    .sort((a, b) => bandNum(a.band) - bandNum(b.band) || a.name.localeCompare(b.name));

  // LEADS — status Qualified or Trial Scheduled (the "sit-in" stage)
  const rawLeads = await boardItems(LEADS_BOARD);
  const SECTION = { "Qualified": "Qualified", "Trial Scheduled": "Sit-In" };
  const leads = rawLeads
    .filter(it => SECTION[val(it, COL.l_status)])
    .map(it => {
      const sec = SECTION[val(it, COL.l_status)];
      return {
        id: it.id, name: it.name, status: sec, section: sec,
        instrument: cleanInstrument(val(it, COL.l_instr)), program: val(it, COL.l_program) || "",
      };
    })
    .sort((a, b) => (a.section === b.section ? a.name.localeCompare(b.name) : a.section === "Sit-In" ? -1 : 1));

  const stamp = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" });
  writeFileSync("roster.json", JSON.stringify({ members, leads, stamp }, null, 1));
  console.log(`roster.json written: ${members.length} members, ${leads.length} leads (${stamp})`);
}

main().catch(e => { console.error(e); process.exit(1); });
