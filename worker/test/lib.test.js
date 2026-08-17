import { describe, it, expect } from "vitest";
import {
  decodeEntities, stripHtml, truncate,
  parseClock, parseTimeRange, parseWeekdays,
  statusOf, agesLabel, coversAny, shapeSection, filterSections, groupPrograms,
  resolveFacet, resolveOrg, resolveSeason, localStamp, closeStamp,
  shapeScheduleAndWindow, shapeButtonStatus, shapePrice,
  flattenDropins, filterDropins,
  sanitizeCell, renderProgramsMarkdown, renderDropinsMarkdown,
} from "../src/lib.js";

// Real captured payloads (probed live 2026-08-16; see docs/activenet-api.md).
const RAW_ITEM = {
  id: 89410, name: "Dual Lane Aqua Run Event 12:30", desc: "<p>Race a friend!&nbsp;&amp; more</p>",
  days_of_week: "Sun", time_range: "12:30 PM - 1:30 PM",
  date_range_start: "2026-11-01", date_range_end: "",
  age_min_year: 6, age_max_year: 0, total_open: 90, number: "95301",
  location: { label: "Evans Pool" },
};

const RAW_MRD = {
  activity_id: 89410,
  activity_patterns: [{
    beginning_date: "2026-11-01", ending_date: "2026-11-01", exception_dates: [],
    pattern_dates: [{ weekdays: "Sun", starting_time: "12:30:00", ending_time: "13:30:00" }],
  }],
  enrollment_datetimes: [{
    first_daytime_internet: "2026-08-11 12:00:00",
    first_daytime_internet_members: "2026-08-04 12:00:00",
    last_daytime_internet: "2026-11-01 00:00:00",
  }],
};

const BTN_OPEN = { button_status: { action_link: { href: "https://x/enroll/89410", label: "Enroll Now" }, notification: "" } };
const BTN_CLOSED = { button_status: { action_link: null, notification: "We're sorry, but online registration is not allowed for this activity. Please contact us during regular business hours for registration information." } };

describe("text", () => {
  it("decodes entities", () => expect(decodeEntities("A &amp; B&nbsp;&#39;C&#39;")).toBe("A & B 'C'"));
  it("strips html to text", () => expect(stripHtml("<p>Hello <b>world</b></p><p>Bye</p>")).toBe("Hello world Bye"));
  it("truncates on word boundary with ellipsis", () => {
    const t = truncate("a".repeat(100) + " tail words here", 105);
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(106);
  });
});

describe("clock parsing", () => {
  it.each([
    ["5:15 PM", 17 * 60 + 15], ["12:30 AM", 30], ["Noon", 720], ["Midnight", 0], ["11:30 AM", 690],
  ])("%s", (s, want) => expect(parseClock(s)).toBe(want));
  it("rejects garbage", () => expect(parseClock("whenever")).toBeNull());
  it("parses ranges incl. the Noon quirk", () => {
    expect(parseTimeRange("12:30 PM - 1:30 PM")).toEqual({ start: "12:30", end: "13:30" });
    expect(parseTimeRange("11:30 AM - Noon")).toEqual({ start: "11:30", end: "12:00" });
    expect(parseTimeRange("TBD")).toBeNull();
  });
});

describe("weekdays", () => {
  it("parses lists and aliases in week order", () => {
    expect(parseWeekdays("Thu, Tue")).toEqual(["Tue", "Thu"]);
    expect(parseWeekdays("Weekdays")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
    expect(parseWeekdays("gibberish")).toEqual([]);
  });
});

describe("sections", () => {
  it("status semantics: -1 drop-in, 0 full, n open", () => {
    expect(statusOf(-1)).toBe("drop_in");
    expect(statusOf(0)).toBe("full");
    expect(statusOf(7)).toBe("open");
  });
  it("age band is [min, max) with 0 = unbounded", () => {
    expect(agesLabel(5, 9)).toBe("5-8");
    expect(agesLabel(6, 0)).toBe("6+");
    expect(coversAny(5, 9, [8])).toBe(true);
    expect(coversAny(5, 9, [9])).toBe(false); // exclusive max
    expect(coversAny(6, 0, [40])).toBe(true);
  });
  it("shapes a real upstream item", () => {
    const s = shapeSection(RAW_ITEM);
    expect(s).toMatchObject({
      id: 89410, location: "Evans Pool", weekdays: ["Sun"],
      start_time: "12:30", end_time: "13:30", date_start: "2026-11-01",
      spots: 90, status: "open", description: "Race a friend! & more",
    });
  });
  it("filters by age/day/time but keeps unparseable rows visible", () => {
    const parsed = shapeSection(RAW_ITEM);
    const odd = { ...parsed, weekdays: [], start_time: null, end_time: null };
    expect(filterSections([parsed], { ages: [8] })).toHaveLength(1);
    expect(filterSections([parsed], { ages: [4] })).toHaveLength(0);
    expect(filterSections([parsed], { weekdays: ["Sat"] })).toHaveLength(0);
    expect(filterSections([odd], { weekdays: ["Sat"], start_after: "18:00" })).toHaveLength(1); // fail open, visibly
    expect(filterSections([parsed], { start_after: "13:00" })).toHaveLength(0);
    expect(filterSections([parsed], { end_before: "14:00" })).toHaveLength(1);
  });
});

describe("program grouping (synthesized: upstream has none)", () => {
  it("groups by name+location with rollups and union age band", () => {
    const mk = (over) => shapeSection({ ...RAW_ITEM, ...over });
    const programs = groupPrograms([
      mk({ id: 1, age_min_year: 5, age_max_year: 9 }),
      mk({ id: 2, age_min_year: 7, age_max_year: 13, total_open: 0 }),
      mk({ id: 3, name: "Other Thing" }),
    ]);
    expect(programs).toHaveLength(2);
    const p = programs.find((x) => x.name.startsWith("Dual Lane"));
    expect(p.sections).toHaveLength(2);
    expect(p.open).toBe(1);
    expect(p.full).toBe(1);
    expect(p.ages).toBe("5-12");
    expect(p.sections[0]).toMatchObject({ id: 1, time: "12:30-13:30", status: "open" });
  });
});

describe("facet resolution — never guesses", () => {
  const facet = [
    { id: 500, desc: "Evans Pool" },
    { id: 16, desc: "Medgar Evers Pool" },
    { id: 307, desc: "Madison Pool" },
    { id: 8, desc: "Garfield Community Center" },
  ];
  it("numeric ids verified against vocabulary", () => {
    const r = resolveFacet(["500", "999"], facet);
    expect(r.ids).toEqual(["500"]);
    expect(r.unmatched).toEqual(["999"]);
  });
  it("unique substring resolves; exact beats substring", () => {
    const r = resolveFacet(["medgar evers", "Evans Pool"], facet);
    expect(r.resolved.map((x) => x.name)).toEqual(["Medgar Evers Pool", "Evans Pool"]);
  });
  it("ambiguity is reported with candidates, not picked", () => {
    const r = resolveFacet(["pool"], facet);
    expect(r.ids).toEqual([]);
    expect(r.ambiguous[0].candidates).toHaveLength(3);
  });
});

describe("season resolution — bare words pick the upcoming instance, loudly", () => {
  // Real Seattle vocabulary shape (2026-08-16).
  const seasons = [
    { id: "48", desc: "Fall 2025" }, { id: "52", desc: "Fall 2026" },
    { id: "51", desc: "Summer 2026" }, { id: "54", desc: "Winter 2027" },
  ];
  it('"fall" resolves to the upcoming Fall with a note', () => {
    const r = resolveSeason("fall", seasons, "2026-08-16");
    expect(r.resolved[0]).toEqual({ id: "52", name: "Fall 2026" });
    expect(r.notes[0]).toMatch(/Fall 2026.*Fall 2025/s);
  });
  it("a full name resolves exactly, no note", () => {
    const r = resolveSeason("Fall 2025", seasons, "2026-08-16");
    expect(r.resolved[0].id).toBe("48");
    expect(r.notes).toEqual([]);
  });
  it("a numeric id resolves", () => expect(resolveSeason("51", seasons, "2026-08-16").ids).toEqual(["51"]));
  it("nonsense falls back to all seasons with a note", () => {
    const r = resolveSeason("monsoon", seasons, "2026-08-16");
    expect(r.ids).toEqual([]);
    expect(r.notes[0]).toMatch(/ALL seasons/);
  });
  it("only-past instances pick the latest past one", () => {
    const r = resolveSeason("fall", [{ id: "1", desc: "Fall 2023" }, { id: "2", desc: "Fall 2024" }], "2026-08-16");
    expect(r.resolved[0].id).toBe("2");
  });
});

describe("org resolution", () => {
  const tenants = [
    { slug: "seattle", name: "Seattle Parks and Recreation" },
    { slug: "portlandparks", name: "Portland Parks & Recreation" },
    { slug: "kentparkandrec", name: "Kent Parks and Recreation Online Registration" },
    { slug: "kentparksandrec", name: "ActiveNet - Online Recreation Activities" },
  ];
  it("exact slug wins", () => expect(resolveOrg("seattle", tenants).slug).toBe("seattle"));
  it("unique name resolves", () => expect(resolveOrg("Portland", tenants).slug).toBe("portlandparks"));
  it("ambiguous returns candidates", () => expect(resolveOrg("kent", tenants).ambiguous).toHaveLength(2));
  it("unknown slug-shaped passes through unverified (registry not exhaustive)", () => {
    expect(resolveOrg("sfrecpark", tenants)).toMatchObject({ slug: "sfrecpark", unverified: true });
  });
  it("unknown non-slug is rejected", () => expect(resolveOrg("Mars Colony One", tenants).unknown).toBeDefined());
});

describe("detail-tier synthesis (real captured payloads)", () => {
  it("schedule + registration window", () => {
    const sw = shapeScheduleAndWindow(RAW_MRD);
    expect(sw.schedule[0].meets[0]).toEqual({ days: ["Sun"], start: "12:30", end: "13:30" });
    expect(sw.window).toEqual({
      opens: "2026-08-11T12:00", opens_members: "2026-08-04T12:00", closes: "2026-11-01T23:59",
    });
  });
  it("midnight closes mean end-of-day (upstream renders 00:00:00 as 11:59 PM — activity 84194)", () => {
    expect(closeStamp("2026-08-13 00:00:00")).toBe("2026-08-13T23:59");
    expect(closeStamp("2026-08-13 14:00:00")).toBe("2026-08-13T14:00"); // real intra-day close passes through
    expect(closeStamp(null)).toBeNull();
  });
  it("buttonstatus verdicts, both directions", () => {
    expect(shapeButtonStatus(BTN_OPEN)).toMatchObject({ enrollable_now: true, enroll_url: "https://x/enroll/89410", reason: null });
    const closed = shapeButtonStatus(BTN_CLOSED);
    expect(closed.enrollable_now).toBe(false);
    expect(closed.reason).toMatch(/online registration is not allowed/);
  });
  it("prices: free, flat, tiered-resident (tiers always ride along)", () => {
    expect(shapePrice({ free: true })).toEqual({ free: true, fee: "$0.00" });
    expect(shapePrice({ estimate_price: "$91.50" }).fee).toBe("$91.50");
    const r = shapePrice({ prices: [{ details: [{ description: "Non-Resident", price: "$20" }, { description: "Resident", price: "$10" }] }] });
    expect(r.fee).toBe("$10");
    expect(r.fee_label).toBe("Resident");
    expect(r.tiers).toHaveLength(2);
  });
  it("prices: unrecognized tier scheme yields fee:null + raw tiers, never a guess (activity 88865)", () => {
    // Real captured payload — the member/non-member scholarship scheme that
    // shapePrice used to mislabel as a $42 "resident_fee" (real price $84).
    const r = shapePrice({
      estimate_price: "",
      free: false,
      prices: [{ details: [
        { price: "$42.00", description: "Member of package:<br>Scholarship Eligible<br><br>" },
        { price: "$84.00", description: "Non-member of package:<br>Scholarship Eligible<br><br>" },
      ] }],
    });
    expect(r.fee).toBeNull();
    expect(r.fee_note).toMatch(/no single fee/i);
    expect(r.tiers).toEqual([
      { label: "Member of package: Scholarship Eligible", price: "$42.00" },
      { label: "Non-member of package: Scholarship Eligible", price: "$84.00" },
    ]);
  });
  it("localStamp normalizes upstream datetimes", () => {
    expect(localStamp("2026-08-11 12:00:00")).toBe("2026-08-11T12:00");
    expect(localStamp("")).toBeNull();
  });
});

describe("markdown rendering (skim tiers)", () => {
  it("sanitizes cells: pipes and newlines", () => {
    expect(sanitizeCell("A | B\nC")).toBe("A / B C");
  });
  it("renders programs: header, legend, one pipe-row per section", () => {
    const programs = groupPrograms([
      shapeSection(RAW_ITEM),
      shapeSection({ ...RAW_ITEM, id: 2, total_open: 0 }),
      shapeSection({ ...RAW_ITEM, id: 3, total_open: -1, name: "Open | Swim" }),
    ]);
    const md = renderProgramsMarkdown(
      { org: "seattle", sections_count: 3, query_line: "keyword=swim · season=Fall 2026 (52)", notes: ["Season note"], next_step: "drill next" },
      programs
    );
    expect(md).toMatch(/^# seattle: 2 programs \/ 3 sections\n/);
    expect(md).toContain("query: keyword=swim");
    expect(md).toContain("note: Season note");
    expect(md).toContain("sections format: id | days | time | dates | spots");
    expect(md).toContain("## Dual Lane Aqua Run Event 12:30 — Evans Pool (ages 6+)");
    expect(md).toContain("89410 | Sun | 12:30-13:30 | 2026-11-01..2026-11-01 | 90 open");
    expect(md).toContain("| full");
    expect(md).toContain("| drop-in");
    expect(md).toContain("## Open / Swim"); // pipe sanitized out of the heading
    expect(md).not.toContain("[object Object]");
  });
  it("renders dropins grouped by date with weekday labels", () => {
    const sessions = [
      { date: "2026-08-22", start: "09:00", end: "10:30", title: "Lap Swim", center: "Green Lake CC", facilities: ["Pool"] },
      { date: "2026-08-22", start: "18:00", end: "20:00", title: "Open Gym", center: "Rainier CC", facilities: [] },
    ];
    const md = renderDropinsMarkdown(
      { org: "seattle", date_from: "2026-08-16", date_to: "2026-08-23", window_from: "2026-08-10", window_to: "2026-09-19", query_line: "keyword=swim", notes: ["defaulted note"] },
      sessions
    );
    expect(md).toMatch(/^# seattle drop-ins: 2 sessions, 2026-08-16\.\.2026-08-23 \(upstream window 2026-08-10\.\.2026-09-19\)\n/);
    expect(md).toContain("## 2026-08-22 (Sat)");
    expect(md).toContain("09:00-10:30 | Lap Swim | Green Lake CC | Pool");
    expect(md).toContain("18:00-20:00 | Open Gym | Rainier CC | -");
  });
});

describe("drop-ins", () => {
  const body = {
    center_events: [{
      center_name: "Green Lake Community Center",
      events: [
        { title: "Lap Swim", start_time: "2026-08-22 09:00:00", end_time: "2026-08-22 10:30:00", event_item_id: 1, facilities: [{ facility_name: "Pool" }] },
        { title: "Open Gym", start_time: "2026-08-20 18:00:00", end_time: "2026-08-20 20:00:00", event_item_id: 2, facilities: [] },
      ],
    }],
  };
  it("flattens sorted by date then time", () => {
    const s = flattenDropins(body, "Swimming");
    expect(s.map((x) => x.title)).toEqual(["Open Gym", "Lap Swim"]);
    expect(s[1]).toMatchObject({ date: "2026-08-22", start: "09:00", end: "10:30", center: "Green Lake Community Center", calendar: "Swimming" });
  });
  it("filters worker-side (dates, keyword, centers)", () => {
    const s = flattenDropins(body, "Swimming");
    expect(filterDropins(s, { date_from: "2026-08-21" })).toHaveLength(1);
    expect(filterDropins(s, { keyword: "lap" })).toHaveLength(1);
    expect(filterDropins(s, { centers: ["green lake"] })).toHaveLength(2);
    expect(filterDropins(s, { centers: ["Rainier"] })).toHaveLength(0);
  });
});
