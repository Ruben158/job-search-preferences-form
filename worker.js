/**
 * Job Radar — Cloudflare Worker
 *
 * Flow:
 * 1. Receive POST from the form (workType, city, country, industry, roleType, skills, email, resume)
 * 2. If a resume was uploaded, send it to Gemini to extract skills
 * 3. Remote search: fetch Remotive, Arbeitnow, RemoteOK, Himalayas, Jobicy, The Muse,
 *    Working Nomads and We Work Remotely in parallel, then filter by country
 *    In-person search: fetch Adzuna (India) for Mumbai, Pune or Bangalore
 * 4. Score jobs against combined skill set (typed skills + resume-extracted skills)
 * 5. Ask Gemini for a short personalized blurb per top match
 * 6. Email the results via the Gmail API
 *
 * Secrets required (Settings -> Variables and Secrets):
 *   GEMINI_API_KEY, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
 *   GMAIL_SENDER_EMAIL, ADZUNA_APP_ID, ADZUNA_APP_KEY
 */

const GEMINI_MODEL = "gemini-3.5-flash-lite"; // update here if you want to swap models later

// In-person search is limited to these cities for now.
const CITY_SEARCH_TERMS = {
  Mumbai: ["Mumbai"],
  Pune: ["Pune"],
  Bangalore: ["Bangalore", "Bengaluru"],
};

// Words in a job's location text that mean "open to candidates in this country".
const COUNTRY_ALIASES = {
  India: ["india", "asia", "apac", "asia-pacific"],
  "United States": ["united states", "usa", "us", "america", "americas", "north america"],
  "United Kingdom": ["united kingdom", "uk", "england", "europe", "emea"],
  Canada: ["canada", "north america", "americas"],
  Germany: ["germany", "europe", "emea", "dach"],
  Australia: ["australia", "apac", "oceania"],
  Singapore: ["singapore", "asia", "apac"],
  "United Arab Emirates": ["uae", "united arab emirates", "dubai", "middle east", "emea"],
};
const OPEN_LOCATION_WORDS = ["worldwide", "anywhere", "global", "remote", "international", "all countries"];

const MAX_RESULTS = 10;
const MAX_ROLES = 4;

// How long the jobs we sent to someone are kept (only for people who ticked "remember").
const HISTORY_DAYS = 60;

// Job sources are cached for a few hours, so repeated searches reuse one answer instead of calling the
// source every time (Remotive asks for very few calls a day, and Adzuna has daily limits).
const SOURCE_CACHE_SECONDS = 10800;

// Adzuna's terms require a "Jobs by Adzuna" label with their logo on every Adzuna advert.
// Download the logo from adzuna.co.uk/press.html and upload it to the GitHub repo under this name.
const ADZUNA_LOGO_URL = "https://ruben158.github.io/job-search-preferences-form/adzuna-logo.png";

const REMOTE_SOURCES = ["Remotive", "Himalayas", "Jobicy", "Arbeitnow", "RemoteOK", "The Muse", "Working Nomads", "We Work Remotely"];

// Some role names list two titles ("Compliance / AML Analyst") or add brackets ("Site Reliability Engineer (SRE)").
// Job sites search better with one clean title, so the list below overrides the automatic rule where it guesses badly.
const ROLE_SEARCH_OVERRIDES = {
  "QA / Automation Test Engineer": "QA Engineer",
  "Compliance / AML Analyst": "AML Analyst",
  "Paralegal / Legal Assistant": "Paralegal",
  "Teacher / Instructor": "Teacher",
  "Technical Writer / Copywriter": "Technical Writer",
  "Growth Marketer / Digital Marketing Specialist": "Digital Marketing Specialist",
  "SEO / Content Specialist": "SEO Specialist",
  "Quality Assurance (QA/QC) Specialist": "Quality Assurance Specialist",
  "Management Consultant / Strategy Consultant": "Management Consultant",
  "Academic Advisor / Admissions Counselor": "Admissions Counselor",
  "Development / Fundraising Associate": "Fundraising Associate",
};
const FETCH_TIMEOUT_MS = 8000;

// Only the Job Radar form may call this Worker (browsers always send an Origin header).
const ALLOWED_ORIGINS = ["https://ruben158.github.io"];

// Experience bands the form offers, in years.
const EXPERIENCE_BANDS = {
  "0-1": { min: 0, max: 1, label: "fresher" },
  "1-3": { min: 1, max: 3, label: "1 to 3 years" },
  "3-5": { min: 3, max: 5, label: "3 to 5 years" },
  "5-8": { min: 5, max: 8, label: "5 to 8 years" },
  "8+": { min: 8, max: 99, label: "8+ years" },
};

// Salary bands in lakh rupees per year (LPA), used for in-person searches.
const SALARY_BANDS_LPA = {
  "0-3": { lo: 0, hi: 3, label: "up to 3 LPA" },
  "3-5": { lo: 3, hi: 5, label: "3 to 5 LPA" },
  "5-8": { lo: 5, hi: 8, label: "5 to 8 LPA" },
  "8-12": { lo: 8, hi: 12, label: "8 to 12 LPA" },
  "12-20": { lo: 12, hi: 20, label: "12 to 20 LPA" },
  "20+": { lo: 20, hi: Infinity, label: "above 20 LPA" },
};

// Safe lookup that ignores inherited keys like "constructor" or "__proto__".
function hasKey(obj, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const reply = (response) => corsResponse(response, origin);

    // Pages opened from the links in an email (no CORS: they are normal web pages, not form calls).
    const pagePath = new URL(request.url).pathname;
    if (request.method === "GET" && pagePath === "/jobs") return historyPage(request, env);
    if (pagePath === "/delete" && (request.method === "GET" || request.method === "POST")) {
      return deletePage(request, env);
    }

    // CORS preflight (form is hosted on GitHub Pages, a different origin)
    if (request.method === "OPTIONS") {
      return reply(new Response(null, { status: 204 }));
    }

    if (request.method !== "POST") {
      return reply(new Response("Job Radar worker is running. POST your form data here.", { status: 200 }));
    }

    // Reject calls that don't come from the Job Radar form. This stops casual misuse from other
    // websites; it can't stop someone who deliberately fakes the header, which is what the daily limits are for.
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return reply(jsonResponse({ error: "Requests are only accepted from the Job Radar form." }, 403));
    }

    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const day = new Date().toISOString().slice(0, 10);

    // Lets someone ask for a fresh link to their saved jobs without searching again.
    // The answer is the same whether or not anything is saved, so it can't be used to look up an address.
    if (url.pathname === "/my-jobs-link") {
      try {
        const body = await request.json();
        const email = typeof body.email === "string" ? body.email.trim() : "";
        if (!isValidEmail(email)) {
          return reply(jsonResponse({ error: "Please enter a valid email address." }, 400));
        }
        const offReason = savedJobsOffReason(env);
        if (offReason) {
          console.error("Saved jobs are off: " + offReason);
          return reply(jsonResponse({ error: "Saved jobs are not switched on yet." }, 503));
        }
        const emailKey = await sha256Hex(email.toLowerCase());
        if ((await overLimit(env, `rl:link-ip:${ip}:${day}`, 10)) || (await overLimit(env, `rl:link-email:${emailKey}:${day}`, 3))) {
          return reply(jsonResponse({ error: "Daily limit reached. Please try again tomorrow." }, 429));
        }
        const person = await hmacHex(env.HASH_SECRET, "person:" + email.toLowerCase());
        const holdsData = await hasHistory(env, person);
        let links = null;
        if (holdsData) {
          const token = await hmacHex(env.HASH_SECRET, "access:" + person);
          const base = new URL(request.url).origin;
          links = { viewUrl: `${base}/jobs?p=${person}&t=${token}`, deleteUrl: `${base}/delete?p=${person}&t=${token}` };
        }
        await deliverEmail(env, email, "Job Radar: your saved jobs", buildLinkEmailHtml(links));
        return reply(jsonResponse({ ok: true }));
      } catch (err) {
        console.error("my-jobs-link failed:", err.message);
        return reply(jsonResponse({ error: "Something went wrong. Please try again." }, 500));
      }
    }

    // Lightweight endpoint: just read a resume, no job search/email.
    // Called by the form the moment a resume is selected, to auto-fill skills and experience.
    if (url.pathname === "/extract-skills") {
      try {
        if (await overLimit(env, `rl:skills:${ip}:${day}`, 30)) {
          return reply(jsonResponse({ error: "Daily limit reached. Please try again tomorrow." }, 429));
        }
        const body = await request.json();
        const { resumeBase64 } = body;
        if (!resumeBase64) {
          return reply(jsonResponse({ error: "Missing resumeBase64." }, 400));
        }
        const catalog = sanitizeCatalog(body.catalog);
        const parsed = await extractResumeInfo(resumeBase64, env.GEMINI_API_KEY, catalog);
        return reply(
          jsonResponse({
            ok: true,
            skills: parsed.skills || [],
            experienceYears: toYears(parsed.yearsOfExperience),
            email: cleanEmail(parsed.email),
            ...validateSuggestions(parsed, catalog),
          })
        );
      } catch (err) {
        console.error("extract-skills failed:", err.message);
        return reply(jsonResponse({ error: err.message || "Extraction failed" }, 500));
      }
    }

    try {
      const body = await request.json();
      const { skills, resumeBase64 } = body;
      // Stray spaces around an address are harmless, so trim them instead of rejecting the request.
      const email = typeof body.email === "string" ? body.email.trim() : body.email;
      const remember = body.remember === true;
      const excludeTerms = sanitizeExclude(body.exclude);
      const workType = body.workType === "onsite" ? "onsite" : "remote";
      const city = typeof body.city === "string" ? body.city : "";
      const country = typeof body.country === "string" ? body.country : "";
      let experience = hasKey(EXPERIENCE_BANDS, body.experience) ? body.experience : "";
      // Salary only applies to in-person searches (remote jobs are mostly paid in other currencies).
      const salaryBand = workType === "onsite" && hasKey(SALARY_BANDS_LPA, body.salary) ? body.salary : "";

      // The form sends up to 4 roles; older versions of the form send a single roleType.
      const rawRoles = Array.isArray(body.roles) ? body.roles : [body.roleType];
      const searchRoles = Array.from(new Set(rawRoles.map(roleSearchTerm).filter(Boolean))).slice(0, MAX_ROLES);
      if (searchRoles.length === 0) searchRoles.push(""); // no role given: search without one
      const manyRoles = searchRoles.length > 1;
      const roleText = searchRoles.filter(Boolean).join(", ");

      if (!email || !skills) {
        return reply(jsonResponse({ error: "Missing required fields: email and skills." }, 400));
      }
      if (!isValidEmail(email)) {
        return reply(jsonResponse({ error: "Please enter a valid email address." }, 400));
      }
      if (workType === "onsite" && !hasKey(CITY_SEARCH_TERMS, city)) {
        return reply(
          jsonResponse({ error: "Please choose Mumbai, Pune or Bangalore for in-person jobs." }, 400)
        );
      }

      // Daily limits (only enforced when the optional RATE_KV storage is connected).
      const emailKey = await sha256Hex(String(email).trim().toLowerCase());
      if ((await overLimit(env, `rl:ip:${ip}:${day}`, 20)) || (await overLimit(env, `rl:email:${emailKey}:${day}`, 3))) {
        return reply(jsonResponse({ error: "Daily limit reached. Please try again tomorrow." }, 429));
      }

      // --- Saved history (only when the D1 database and HASH_SECRET are connected) ---
      // person is a keyed hash of the email: the database never holds the address itself.
      let history = null; // { person, holdsData, seen: Set }
      const offReason = savedJobsOffReason(env);
      if (offReason && remember) console.error("Saved jobs are off, so this search was not remembered: " + offReason);
      if (!offReason) {
        try {
          const person = await hmacHex(env.HASH_SECRET, "person:" + String(email).trim().toLowerCase());
          if (remember) await purgeOldHistory(env);
          const holdsData = await hasHistory(env, person);
          history = { person, holdsData, seen: remember && holdsData ? await getSeenKeys(env, person) : new Set() };
        } catch (err) {
          console.error("History lookup failed (continuing without it):", err.message);
          history = null;
        }
      }

      // --- Step 1: optionally parse the resume via Gemini ---
      let resumeSkills = [];
      let resumeSummary = null;

      if (resumeBase64) {
        try {
          const parsed = await extractResumeInfo(resumeBase64, env.GEMINI_API_KEY);
          resumeSkills = parsed.skills || [];
          resumeSummary = parsed.summary || null;
          // If the person left experience blank, use the estimate from the resume.
          if (!experience) experience = bandFromYears(toYears(parsed.yearsOfExperience));
        } catch (err) {
          // Don't fail the whole request if resume parsing has a hiccup —
          // just fall back to the typed skills field.
          console.error("Resume parsing failed:", err.message);
        }
      }

      const typedSkills = String(skills)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const allSkills = Array.from(
        new Set([...typedSkills, ...resumeSkills.map((s) => String(s).toLowerCase())])
      );

      // --- Step 2: fetch jobs ---
      let allJobs;
      let searchLabel;
      let fetchedBySource = {};

      if (workType === "onsite") {
        // One Adzuna search per role; fewer results each when there are several roles.
        const perRole = await Promise.all(
          searchRoles.map((r) => fetchAdzunaIndia(r, city, env, manyRoles ? 25 : 50))
        );
        allJobs = perRole.flat();
        fetchedBySource = countBySource(allJobs);
        searchLabel = `in-person jobs in ${city}` + (roleText ? ` for ${roleText}` : "");
        if (salaryBand) searchLabel += `, salary ${SALARY_BANDS_LPA[salaryBand].label}`;
      } else {
        // Remotive, Himalayas and Jobicy are searched once per role; the other sources have no role search.
        const results = await Promise.all([
          ...searchRoles.map((r) => fetchRemotive(r, manyRoles ? 50 : 100)),
          ...searchRoles.map((r) => fetchHimalayas(r)),
          ...searchRoles.map((r) => fetchJobicy(r, manyRoles ? 30 : 50)),
          fetchArbeitnow(),
          fetchRemoteOK(),
          fetchTheMuse(),
          fetchWorkingNomads(),
          fetchWeWorkRemotely(),
        ]);
        const fetched = results.flat();
        fetchedBySource = Object.fromEntries(REMOTE_SOURCES.map((s) => [s, 0]));
        Object.assign(fetchedBySource, countBySource(fetched));
        allJobs = fetched.filter((j) => matchesCountry(j, country));
        searchLabel =
          (country ? `remote jobs open to candidates in ${country}` : "remote jobs") +
          (roleText ? ` for ${roleText}` : "");
      }
      if (experience) searchLabel += `, ranked for ${EXPERIENCE_BANDS[experience].label} experience`;
      if (excludeTerms.length > 0) searchLabel += `, leaving out ${excludeTerms.join(", ")}`;

      allJobs = dedupeJobs(allJobs);

      // Remote searches: drop listings that say they are only for residents or citizens of another region.
      const afterCountryFilter = allJobs.length;
      if (workType === "remote") allJobs = dropRegionRestricted(allJobs, country).kept;
      const afterRegionFilter = allJobs.length;

      // Drop listings that look like scams (fee demands, WhatsApp-only contact, "earn per day" promises).
      const { kept, blocked } = removeScams(allJobs);
      allJobs = kept;
      if (blocked.length > 0) {
        console.log(`Blocked ${blocked.length} suspected scam listing(s):`, JSON.stringify(blocked.slice(0, 20)));
      }
      const afterScamFilter = allJobs.length;

      // Drop titles and companies the person asked us to leave out.
      allJobs = applyExclusions(allJobs, excludeTerms).kept;

      // --- Step 3: score and pick the best matches ---
      // Leave out jobs this person was already sent (only if they asked us to remember).
      const seen = history ? history.seen : new Set();
      const pool = seen.size > 0 ? allJobs.filter((j) => !seen.has(jobKey(j))) : allJobs;
      const scored = pickTopJobs(pool, allSkills, workType, searchRoles, { experience, salaryBand });
      // "Nothing new" means matches exist but every one was sent before.
      const nothingNew =
        scored.length === 0 && seen.size > 0 && pickTopJobs(allJobs, allSkills, workType, searchRoles, { experience, salaryBand }).length > 0;

      // One line per search showing how many jobs each source returned. It holds no email, skills or resume.
      console.log(
        "Search summary",
        JSON.stringify({
          workType,
          roles: searchRoles,
          country,
          city,
          fetchedBySource,
          afterCountryFilter,
          afterRegionFilter,
          afterScamFilter,
          afterExclusions: allJobs.length,
          emailed: scored.length,
        })
      );

      // Links that open the same search on other job sites (we can't read their listings directly).
      const searchLinks = buildSearchLinks({
        roles: searchRoles.filter(Boolean),
        workType,
        city,
        country,
        experience,
      });

      // Links to view or delete saved jobs appear whenever we hold data about this person
      // (or are about to); otherwise the email says nothing was saved.
      const extras = { nothingNew, onlyNew: seen.size > 0 };
      if (history) {
        if (remember || history.holdsData) {
          const token = await hmacHex(env.HASH_SECRET, "access:" + history.person);
          const base = new URL(request.url).origin;
          extras.viewUrl = `${base}/jobs?p=${history.person}&t=${token}`;
          extras.deleteUrl = `${base}/delete?p=${history.person}&t=${token}`;
        } else {
          extras.notSaved = true;
        }
      }

      if (scored.length === 0) {
        // Still email the person so they know it ran, just with no matches.
        await sendEmail(env, email, [], resumeSummary, searchLabel, searchLinks, extras);
        return reply(
          jsonResponse({ ok: true, matches: 0, nothingNew, message: nothingNew ? "Nothing new since last time." : "No matching jobs found this run." })
        );
      }

      // --- Step 4: personalized blurbs per job via Gemini ---
      const withBlurbs = await addBlurbs(scored, allSkills, env.GEMINI_API_KEY, {
        experienceLabel: experience ? EXPERIENCE_BANDS[experience].label : "",
        roles: searchRoles.filter(Boolean),
      });

      // --- Step 5: send email ---
      await sendEmail(env, email, withBlurbs, resumeSummary, searchLabel, searchLinks, extras);

      // Remember what was sent only after the email went out, so a failed send is never recorded.
      if (history && remember) {
        try {
          await saveSentJobs(env, history.person, withBlurbs);
        } catch (err) {
          console.error("Saving history failed:", err.message);
        }
      }

      return reply(jsonResponse({ ok: true, matches: withBlurbs.length }));
    } catch (err) {
      console.error("Worker error:", err);
      return reply(jsonResponse({ error: err.message || "Unknown error" }, 500));
    }
  },
};

// ---------- Experience helpers ----------

// Turns a number of years (from the resume) into one of the form's bands. Returns "" if unknown.
function bandFromYears(years) {
  if (!Number.isFinite(years) || years < 0) return "";
  if (years < 1) return "0-1";
  if (years < 3) return "1-3";
  if (years < 5) return "3-5";
  if (years < 8) return "5-8";
  return "8+";
}

function toYears(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 60 ? n : null;
}

const SENIOR_WORDS = /\b(senior|sr\.?|lead|principal|staff|head|director|vp|chief|architect)\b/i;
const JUNIOR_WORDS = /\b(junior|jr\.?|entry[- ]level|entry|intern|internship|trainee|fresher|graduate|apprentice)\b/i;

// Finds the years of experience a listing asks for ("3+ years of experience", "2-4 years experience").
function requiredYears(text) {
  const patterns = [
    /(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?years?[^.]{0,40}experience/i,
    /experience[^.]{0,40}?(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?years?/i,
  ];
  for (const pattern of patterns) {
    const m = String(text || "").match(pattern);
    if (m) return Number(m[1]);
  }
  return null;
}

// How well a listing's level fits the person's experience: roughly -3 (clearly off) to +3 (clearly right).
function experienceScore(job, band) {
  if (!hasKey(EXPERIENCE_BANDS, band)) return 0;
  const b = EXPERIENCE_BANDS[band];
  const head = `${job.title} ${job.level || ""}`;
  const senior = SENIOR_WORDS.test(head);
  const junior = JUNIOR_WORDS.test(head);
  const req = requiredYears(job.description);
  let score = 0;

  if (b.max <= 3) {
    // Fresher to about 3 years: favour junior listings, push down senior ones.
    if (junior) score += 2;
    if (senior) score -= 3;
    if (req !== null) score += req <= b.max + 1 ? 1 : -3;
  } else if (b.min >= 5) {
    // 5+ years: favour senior listings, push down junior ones.
    if (senior) score += 1;
    if (junior) score -= 3;
    if (req !== null) score += req >= b.min - 2 ? 1 : -2;
  } else {
    // 3 to 5 years: mid-level; junior listings fit poorly, senior ones only slightly.
    if (junior) score -= 2;
    if (senior) score -= 1;
    if (req !== null) score += req >= 2 && req <= b.max + 1 ? 1 : -2;
  }
  return score;
}

// ---------- Salary helpers (in-person searches) ----------

// "in" if the listing's salary overlaps the chosen band, "out" if it clearly doesn't, "unknown" if no salary is listed.
function salaryFit(job, band) {
  if (!hasKey(SALARY_BANDS_LPA, band)) return "unknown";
  const min = Number.isFinite(job.salaryMin) ? job.salaryMin : null;
  const max = Number.isFinite(job.salaryMax) ? job.salaryMax : null;
  if (min === null && max === null) return "unknown";
  const lo = (min ?? max) / 100000;
  const hi = (max ?? min) / 100000;
  const { lo: bandLo, hi: bandHi } = SALARY_BANDS_LPA[band];
  return lo <= bandHi && hi >= bandLo ? "in" : "out";
}

function formatSalary(job) {
  const min = Number.isFinite(job.salaryMin) ? job.salaryMin : null;
  const max = Number.isFinite(job.salaryMax) ? job.salaryMax : null;
  if (min === null && max === null) return "";
  const lpa = (v) => String(Number((v / 100000).toFixed(1)));
  const lo = min ?? max;
  const hi = max ?? min;
  const range = lpa(lo) === lpa(hi) ? `${lpa(lo)} LPA` : `${lpa(lo)}\u2013${lpa(hi)} LPA`;
  return `\u20B9${range}${job.salaryPredicted ? " (estimated)" : ""}`;
}

// ---------- Daily limits (optional: needs a KV namespace bound as RATE_KV) ----------

// ---------- Saved history (Cloudflare D1) ----------
// Table to create once in the D1 console (see the setup steps):
//   CREATE TABLE IF NOT EXISTS sent_jobs (person TEXT NOT NULL, job_key TEXT NOT NULL, title TEXT NOT NULL,
//     company TEXT, location TEXT, salary TEXT, url TEXT, source TEXT, sent_at INTEGER NOT NULL,
//     PRIMARY KEY (person, job_key));

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function hmacKey(secret, usages) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

async function hmacHex(secret, message) {
  const key = await hmacKey(secret, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// A link is valid only if its token was made by this Worker's secret for exactly that person.
async function accessAllowed(env, person, token) {
  if (savedJobsOffReason(env)) return false;
  if (!/^[0-9a-f]{64}$/.test(person) || !/^[0-9a-f]{64}$/.test(token)) return false;
  const key = await hmacKey(env.HASH_SECRET, ["verify"]);
  return crypto.subtle.verify("HMAC", key, hexToBytes(token), new TextEncoder().encode("access:" + person));
}

// Anything older than the retention period counts as already gone, even before it is purged.
function retentionCutoff() {
  return Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
}

async function hasHistory(env, person) {
  const row = await env.DB.prepare("SELECT 1 AS found FROM sent_jobs WHERE person = ? AND sent_at >= ? LIMIT 1")
    .bind(person, retentionCutoff())
    .first();
  return Boolean(row);
}

async function getSeenKeys(env, person) {
  const res = await env.DB.prepare("SELECT job_key FROM sent_jobs WHERE person = ? AND sent_at >= ?").bind(person, retentionCutoff()).all();
  return new Set((res.results || []).map((r) => r.job_key));
}

async function saveSentJobs(env, person, jobs) {
  const now = Date.now();
  const statements = jobs.map((j) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO sent_jobs (person, job_key, title, company, location, salary, url, source, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(person, jobKey(j), j.title, j.company || "", j.location || "", formatSalary(j), j.url || "", j.source || "", now)
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

async function purgeOldHistory(env) {
  await env.DB.prepare("DELETE FROM sent_jobs WHERE sent_at < ?").bind(retentionCutoff()).run();
}

// ---------- The two pages opened from an email ----------

function htmlPage(title, body, status = 200) {
  const page = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
  body{margin:0;padding:28px 14px 56px;background:#09090b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6}
  main{max-width:680px;margin:0 auto;padding:26px 22px;background:#121215;border:1px solid #222228;border-radius:18px}
  h1{font-size:22px;margin:0 0 6px;color:#f4f4f5} h2{font-size:15px;margin:22px 0 8px;color:#8e8e99;font-weight:500}
  a{color:#60a5fa} .muted{color:#8e8e99;font-size:14px} ul{padding-left:0;list-style:none;margin:0}
  li{padding:10px 0;border-bottom:1px solid #222228} li:last-child{border-bottom:0} .meta{color:#8e8e99;font-size:13px}
  button{font:inherit;font-weight:600;padding:12px 18px;border:0;border-radius:999px;background:#f87171;color:#09090b;cursor:pointer}
  .cancel{margin-left:14px}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(page, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    },
  });
}

const BAD_LINK_PAGE = () =>
  htmlPage("Link not valid", "<h1>This link isn't valid</h1><p class=\"muted\">It may be incomplete, or the saved jobs may have been deleted.</p>", 403);

// Shows every job we sent this person, newest first.
async function historyPage(request, env) {
  const url = new URL(request.url);
  const person = url.searchParams.get("p") || "";
  const token = url.searchParams.get("t") || "";
  if (!(await accessAllowed(env, person, token))) return BAD_LINK_PAGE();

  const res = await env.DB.prepare(
    "SELECT title, company, location, salary, url, source, sent_at FROM sent_jobs WHERE person = ? AND sent_at >= ? ORDER BY sent_at DESC, rowid DESC LIMIT 300"
  )
    .bind(person, retentionCutoff())
    .all();
  const rows = res.results || [];
  const deleteLink = `/delete?p=${person}&t=${token}`;

  if (rows.length === 0) {
    return htmlPage("Your jobs", "<h1>No saved jobs</h1><p class=\"muted\">Nothing is saved for this email right now.</p>");
  }

  let html = `<h1>Jobs we sent you</h1><p class="muted">Kept for ${HISTORY_DAYS} days, then deleted automatically. Only you have this link, so please don't share it.</p>`;
  let currentDay = "";
  for (const r of rows) {
    const day = new Date(r.sent_at).toISOString().slice(0, 10);
    if (day !== currentDay) {
      if (currentDay) html += "</ul>";
      html += `<h2>Sent on ${escapeHtml(day)}</h2><ul>`;
      currentDay = day;
    }
    const meta = [r.company, r.location, r.salary, r.source].filter(Boolean).map(escapeHtml).join(" &middot; ");
    html += `<li><a href="${escapeHtml(safeUrl(r.url))}" rel="noreferrer">${escapeHtml(r.title)}</a><div class="meta">${meta}</div></li>`;
  }
  html += `</ul><h2>Your data</h2><p><a href="${escapeHtml(deleteLink)}">Delete everything saved about me</a></p>`;
  return htmlPage("Your jobs", html);
}

// GET only asks for confirmation (email scanners open links on their own); POST does the deleting.
async function deletePage(request, env) {
  const url = new URL(request.url);
  let person;
  let token;
  if (request.method === "POST") {
    // The confirmation button posts from this same Worker, so the Origin must be this Worker.
    if (request.headers.get("Origin") !== url.origin) return BAD_LINK_PAGE();
    const form = await request.formData();
    person = String(form.get("p") || "");
    token = String(form.get("t") || "");
  } else {
    person = url.searchParams.get("p") || "";
    token = url.searchParams.get("t") || "";
  }
  if (!(await accessAllowed(env, person, token))) return BAD_LINK_PAGE();

  if (request.method === "POST") {
    const res = await env.DB.prepare("DELETE FROM sent_jobs WHERE person = ?").bind(person).run();
    const count = res?.meta?.changes ?? 0;
    return htmlPage(
      "Deleted",
      `<h1>Deleted</h1><p>${count} saved job${count === 1 ? "" : "s"} removed. Job Radar now keeps nothing linked to your email, and the links in earlier emails no longer show anything.</p>`
    );
  }

  return htmlPage(
    "Delete my data",
    `<h1>Delete everything saved about you?</h1><p class="muted">This removes the list of jobs we sent to your email. It can't be undone.</p>
<form method="POST" action="/delete"><input type="hidden" name="p" value="${escapeHtml(person)}"><input type="hidden" name="t" value="${escapeHtml(token)}">
<button type="submit">Yes, delete it</button><a class="cancel" href="/jobs?p=${escapeHtml(person)}&t=${escapeHtml(token)}">Cancel</a></form>`
  );
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Counts a use against `key` and returns true if the limit was already reached.
// Without the KV storage connected, or if it errors, nothing is limited.
async function overLimit(env, key, max) {
  if (!env.RATE_KV) return false;
  try {
    const current = Number(await env.RATE_KV.get(key)) || 0;
    if (current >= max) return true;
    await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 90000 });
  } catch (err) {
    console.error("Rate limit check failed:", err.message);
  }
  return false;
}

// ---------- "Search more" links for other job sites ----------

function countBySource(jobs) {
  const counts = {};
  for (const job of jobs) counts[job.source] = (counts[job.source] || 0) + 1;
  return counts;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// LinkedIn experience filter codes: 1 internship, 2 entry level, 3 associate, 4 mid-senior, 5 director.
const LINKEDIN_LEVELS = { "0-1": "1,2", "1-3": "2,3", "3-5": "3,4", "5-8": "4", "8+": "4,5" };

function buildSearchLinks({ roles, workType, city, country, experience }) {
  return roles.map((role) => {
    const q = encodeURIComponent(role);
    const place = workType === "onsite" ? (city ? `${city}, India` : "") : country;

    let linkedin = `https://www.linkedin.com/jobs/search/?keywords=${q}`;
    if (place) linkedin += `&location=${encodeURIComponent(place)}`;
    linkedin += `&f_WT=${workType === "onsite" ? "1,3" : "2"}`;
    if (hasKey(LINKEDIN_LEVELS, experience)) linkedin += `&f_E=${LINKEDIN_LEVELS[experience]}`;

    let naukri = `https://www.naukri.com/${slugify(role)}-jobs`;
    if (workType === "onsite" && city) naukri += `-in-${slugify(city)}`;
    if (hasKey(EXPERIENCE_BANDS, experience)) naukri += `?experience=${EXPERIENCE_BANDS[experience].min}`;

    const indeedPlace = workType === "onsite" ? city : "Remote";
    const indeed = `https://in.indeed.com/jobs?q=${q}&l=${encodeURIComponent(indeedPlace)}`;

    return {
      role,
      links: [
        { name: "LinkedIn", url: linkedin },
        { name: "Naukri", url: naukri },
        { name: "Indeed", url: indeed },
      ],
    };
  });
}

function roleSearchTerm(role) {
  if (typeof role !== "string") return "";
  const label = role.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120);
  if (hasKey(ROLE_SEARCH_OVERRIDES, label)) return ROLE_SEARCH_OVERRIDES[label];
  const withoutBrackets = label.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  // Use the first of several alternatives ("Accountant / Auditor" -> "Accountant").
  const first = withoutBrackets.split(/\s+\/\s+/)[0].trim();
  return first || withoutBrackets;
}

// An email address found on a resume, or null if it is missing or doesn't look like a real address.
function cleanEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return isValidEmail(email) ? email : null;
}

function isValidEmail(email) {
  // Rejects line breaks (header injection) and obviously malformed addresses.
  return typeof email === "string" && email.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email);
}

// ---------- CORS helpers ----------

function corsResponse(response, origin) {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  r.headers.set("Vary", "Origin");
  r.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return r;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- Retry helper: Gemini occasionally returns 503 under load ----------
// Retries up to 2 extra times (3 attempts total) with a short backoff, only for 503s.

async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastRes;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastRes = await fetch(url, options);
    if (lastRes.status !== 503) return lastRes;
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 500)); // 500ms, then 1000ms
    }
  }
  return lastRes; // still 503 after retries — caller handles the error
}

// ---------- Role suggestions from the resume ----------
// The form sends its own industry and role lists, so the Worker never has a second copy that could drift.

const MAX_CATALOG_INDUSTRIES = 30;
const MAX_CATALOG_ROLES = 40;
const MAX_NAME_LENGTH = 80;

function cleanName(value) {
  return typeof value === "string" && !/[\u0000-\u001f]/.test(value) ? value.trim() : "";
}

// Accepts { "Industry": ["Role", ...] } and drops anything malformed or oversized.
function sanitizeCatalog(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [rawName, rawRoles] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_CATALOG_INDUSTRIES) break;
    const name = cleanName(rawName);
    if (!name || name.length > MAX_NAME_LENGTH || !Array.isArray(rawRoles)) continue;
    const roles = rawRoles
      .map(cleanName)
      .filter((r) => r && r.length <= MAX_NAME_LENGTH)
      .slice(0, MAX_CATALOG_ROLES);
    if (roles.length > 0) out[name] = roles;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function suggestionInstructions(catalog) {
  return (
    "suggestedIndustry is the one industry from the list below that best fits the career this resume points to, " +
    "and suggestedRoles are up to 4 roles from THAT industry's list that the candidate is best suited for. " +
    "Copy the industry and role names exactly as written in the list. Use null and [] if nothing fits. " +
    "The list (industry: roles): " +
    JSON.stringify(catalog)
  );
}

// Keeps only suggestions that exactly match the lists the form sent, so a made-up name can never get through.
function validateSuggestions(parsed, catalog) {
  const empty = { suggestedIndustry: null, suggestedRoles: [] };
  if (!catalog || !parsed) return empty;
  const industry = typeof parsed.suggestedIndustry === "string" ? parsed.suggestedIndustry.trim() : "";
  if (!hasKey(catalog, industry)) return empty;
  const allowed = new Set(catalog[industry]);
  const roles = Array.isArray(parsed.suggestedRoles)
    ? Array.from(new Set(parsed.suggestedRoles.filter((r) => typeof r === "string" && allowed.has(r.trim())).map((r) => r.trim())))
    : [];
  return roles.length > 0 ? { suggestedIndustry: industry, suggestedRoles: roles.slice(0, MAX_ROLES) } : empty;
}

// ---------- Words or companies the person does not want ----------

const MAX_EXCLUDE_TERMS = 20;
const MAX_EXCLUDE_LENGTH = 40;

function sanitizeExclude(raw) {
  if (!Array.isArray(raw)) return [];
  const terms = raw
    .map((t) => (typeof t === "string" && !/[\u0000-\u001f]/.test(t) ? t.trim().toLowerCase() : ""))
    .filter((t) => t.length >= 2 && t.length <= MAX_EXCLUDE_LENGTH);
  return Array.from(new Set(terms)).slice(0, MAX_EXCLUDE_TERMS);
}

// Matches a whole word or phrase, so "php" never matches "phpstorm" and "ai" never matches "mail".
function termRegex(term) {
  return new RegExp(`(?<![a-z0-9])${escapeRegex(term)}(?![a-z0-9])`, "i");
}

// Only titles and company names are checked: a description that says "no PHP needed" must not hide a job.
function applyExclusions(jobs, terms) {
  if (terms.length === 0) return { kept: jobs, removed: 0 };
  const patterns = terms.map(termRegex);
  const kept = jobs.filter((j) => !patterns.some((rx) => rx.test(j.title) || rx.test(j.company)));
  return { kept, removed: jobs.length - kept.length };
}

// ---------- Listings only for residents or citizens of another region ----------
// Only wording that names a region counts. A bare "no visa sponsorship" is too ambiguous: plenty of
// worldwide remote employers write it about relocation.

const joinPatterns = (...parts) => new RegExp(parts.map((p) => p.source).join("|"), "gi");

const REGION_RESTRICTIONS = [
  {
    local: ["United States"],
    pattern: joinPatterns(
      /\bu\.?s\.?\s+citizens?(?:hip)?\s+(?:only|required)\b/,
      /\b(?:must|need to|required to)\s+be\s+(?:a\s+)?u\.?s\.?\s+citizens?\b/,
      /\bauthori[sz]ed\s+to\s+work\s+in\s+the\s+(?:u\.?s\.?a?\.?|united\s+states)\b/,
      /\bmust\s+(?:reside|live|be\s+(?:located|based))\s+in\s+the\s+(?:u\.?s\.?a?\.?|united\s+states)\b/,
      /\bu\.?s\.?[- ]based\s+(?:candidates?\s+)?only\b/,
      /\bgreen\s+card\s+(?:holders?\s+)?only\b/,
      /\bw-?2\s+only\b/
    ),
  },
  {
    local: ["United Kingdom"],
    pattern: joinPatterns(
      /\bright\s+to\s+work\s+in\s+the\s+(?:uk|united\s+kingdom)\b/,
      /\buk\s+(?:residents?|citizens?)\s+only\b/,
      /\bmust\s+(?:reside|live|be\s+(?:located|based))\s+in\s+the\s+(?:uk|united\s+kingdom)\b/
    ),
  },
  {
    local: ["Germany"],
    pattern: joinPatterns(
      /\bmust\s+(?:reside|live|be\s+(?:located|based))\s+in\s+(?:the\s+)?(?:eu|european\s+union|europe)\b/,
      /\b(?:eu|european)\s+(?:work\s+)?authori[sz]ation\b/,
      /\b(?:eu|european)\s+(?:citizens?|residents?)\s+only\b/
    ),
  },
  {
    local: ["Canada"],
    pattern: joinPatterns(
      /\bauthori[sz]ed\s+to\s+work\s+in\s+canada\b/,
      /\bmust\s+(?:reside|live|be\s+(?:located|based))\s+in\s+canada\b/,
      /\bcanadian\s+(?:citizens?|residents?)\s+only\b/
    ),
  },
  {
    local: ["Australia"],
    pattern: joinPatterns(
      /\bauthori[sz]ed\s+to\s+work\s+in\s+australia\b/,
      /\bmust\s+(?:reside|live|be\s+(?:located|based))\s+in\s+australia\b/,
      /\baustralian\s+(?:citizens?|residents?)\s+only\b/
    ),
  },
];

// Drops listings that say they are only for another region. Does nothing when no country was chosen.
function dropRegionRestricted(jobs, country) {
  if (!country) return { kept: jobs, removed: 0 };
  const rules = REGION_RESTRICTIONS.filter((r) => !r.local.includes(country));
  const kept = jobs.filter((j) => {
    const text = `${j.title} ${j.description}`;
    return !rules.some((r) => hasScamMatch(text, r.pattern));
  });
  return { kept, removed: jobs.length - kept.length };
}

// ---------- Resume parsing (Gemini reads the PDF directly) ----------

async function extractResumeInfo(resumeBase64, apiKey, catalog = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              inline_data: {
                mime_type: "application/pdf",
                data: resumeBase64,
              },
            },
            {
              text:
                "Read this resume. Respond with ONLY a JSON object, no preamble, no markdown fences, in exactly this shape:\n" +
                '{"skills": ["skill1", "skill2", ...], "summary": "one sentence summary of the candidate\'s background", "yearsOfExperience": 3, "email": "name@example.com"' + (catalog ? ', "suggestedIndustry": "Industry name", "suggestedRoles": ["Role name"]' : "") + '}\n' +
                "List 10-20 concrete skills/technologies/competencies (not soft skills like 'teamwork'). " +
                "yearsOfExperience is the total years of full-time professional work experience, as a number " +
                "(use 0 for students, freshers and interns, and null if you cannot tell). " +
                "email is the candidate\'s own email address copied exactly as written on the resume, or null if the resume has none." +
                (catalog ? " " + suggestionInstructions(catalog) : ""),
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini resume parse failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ---------- Job blurbs ----------

async function addBlurbs(jobs, skills, apiKey, context = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const sent = jobs.map((j) => ({ id: j.id, title: j.title, company: j.company, description: j.description?.slice(0, 400) }));

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `Candidate skills: ${skills.join(", ")}\n` +
                (context.experienceLabel ? `Candidate experience: ${context.experienceLabel}\n` : "") +
                (context.roles && context.roles.length ? `Roles wanted: ${context.roles.join(", ")}\n` : "") +
                `\nJobs (JSON array):\n${JSON.stringify(sent)}\n\n` +
                "For each job give three things. " +
                '"note": one sentence on why it fits the candidate\'s skills. ' +
                '"fit": a whole number from 1 (poor) to 5 (excellent), based ONLY on how well the candidate\'s skills and experience match the role and the listing text. ' +
                "Do not guess about pay or whether the employer is trustworthy. " +
                '"gap": the single most important skill or requirement named in the listing text that is missing from the candidate\'s skills, copied from the listing, or "" if there is none. ' +
                'Respond with ONLY a JSON object mapping job id to an object, no preamble, no markdown fences: {"id1": {"note": "...", "fit": 4, "gap": "..."}}',
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    console.error("Blurb generation failed:", res.status, await res.text());
    return jobs.map((j) => ({ ...j, blurb: null }));
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();

  let map = {};
  try {
    map = JSON.parse(clean);
  } catch {
    // if parsing fails, just skip the notes rather than break the email
  }

  const notes = jobs.map((j, index) => {
    const entry = map[j.id];
    // A plain string (the older reply format) still works as just the note.
    if (typeof entry === "string") return { job: { ...j, blurb: entry || null }, index };
    const o = entry && typeof entry === "object" ? entry : {};
    const fit = Number.isInteger(Number(o.fit)) && Number(o.fit) >= 1 && Number(o.fit) <= 5 ? Number(o.fit) : null;
    // A gap is only shown if it really appears in the listing text we sent, which stops invented requirements.
    const gapText = typeof o.gap === "string" ? o.gap.trim().slice(0, 60) : "";
    const listing = `${sent[index].title} ${sent[index].description || ""}`.toLowerCase();
    const gap = gapText && listing.includes(gapText.toLowerCase()) ? gapText : "";
    return { job: { ...j, blurb: typeof o.note === "string" && o.note ? o.note : null, fit, gap }, index };
  });

  // The score is advice: it only changes the order of jobs already chosen, and never removes one.
  return notes
    .sort((a, b) => (b.job.fit ?? 0) - (a.job.fit ?? 0) || a.index - b.index)
    .map((n) => n.job);
}


// ---------- Job source fetchers (normalized to a common shape) ----------
// Every fetcher returns [] on any failure, so one broken source never breaks the email.

function makeJob({ id, title, company, url, description, location, source, roleTag, level, salaryMin, salaryMax, salaryPredicted }) {
  return {
    id: String(id || url || title),
    title: String(title || "").trim(),
    company: String(company || "").trim(),
    url: url || "",
    description: description || "",
    location: String(location || "").trim(),
    source,
    roleTag: roleTag || "",
    level: String(level || "").trim(),
    salaryMin: Number.isFinite(Number(salaryMin)) && salaryMin !== null && salaryMin !== "" ? Number(salaryMin) : null,
    salaryMax: Number.isFinite(Number(salaryMax)) && salaryMax !== null && salaryMax !== "" ? Number(salaryMax) : null,
    salaryPredicted: salaryPredicted === true || salaryPredicted === "1" || salaryPredicted === 1,
  };
}

async function fetchJson(url, label, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: { "User-Agent": "job-radar-worker", ...(options.headers || {}) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": SOURCE_CACHE_SECONDS, "400-599": 0 } },
    });
    if (!res.ok) {
      console.error(`${label} fetch failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`${label} fetch failed:`, err.message);
    return null;
  }
}

function asText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return value ? String(value) : "";
}

async function fetchRemotive(roleType, limit = 100) {
  const q = roleType ? `search=${encodeURIComponent(roleType)}&` : "";
  const data = await fetchJson(`https://remotive.com/api/remote-jobs?${q}limit=${limit}`, "Remotive");
  return (data?.jobs || []).map((j) =>
    makeJob({
      id: `remotive-${j.id}`,
      title: j.title,
      company: j.company_name,
      url: j.url,
      description: stripHtml(j.description),
      location: j.candidate_required_location,
      source: "Remotive",
    })
  );
}

async function fetchArbeitnow() {
  const data = await fetchJson("https://arbeitnow.com/api/job-board-api", "Arbeitnow");
  return (data?.data || [])
    .filter((j) => j.remote === true)
    .map((j) =>
      makeJob({
        id: `arbeitnow-${j.slug}`,
        title: j.title,
        company: j.company_name,
        url: j.url,
        description: stripHtml(j.description),
        location: j.location,
        source: "Arbeitnow",
      })
    );
}

async function fetchRemoteOK() {
  const data = await fetchJson("https://remoteok.com/api", "RemoteOK");
  if (!Array.isArray(data)) return [];
  // The first item is a metadata/legal notice, not a job.
  return data
    .slice(1, 151)
    .filter((j) => j && j.id && j.position)
    .map((j) =>
      makeJob({
        id: `remoteok-${j.id}`,
        title: j.position,
        company: j.company,
        url: j.url || `https://remoteok.com/remote-jobs/${j.id}`,
        description: stripHtml(j.description),
        location: j.location,
        source: "RemoteOK",
      })
    );
}

async function fetchHimalayas(roleType) {
  const url = roleType
    ? `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(roleType)}&sort=recent&page=1`
    : "https://himalayas.app/jobs/api?limit=20";
  const data = await fetchJson(url, "Himalayas");
  const list = data?.jobs || data?.data || [];
  return list.map((j) => {
    const link = j.applicationLink || j.guid || "";
    return makeJob({
      id: `himalayas-${j.guid || link}`,
      title: j.title,
      company: j.companyName,
      url: link,
      description: stripHtml(j.description || j.excerpt),
      location: asText(j.locationRestrictions) || "Worldwide",
      level: asText(j.seniority),
      source: "Himalayas",
    });
  });
}

async function fetchJobicy(roleType, count = 50) {
  const tag = roleType ? `&tag=${encodeURIComponent(roleType)}` : "";
  const data = await fetchJson(`https://jobicy.com/api/v2/remote-jobs?count=${count}${tag}`, "Jobicy");
  return (data?.jobs || []).map((j) =>
    makeJob({
      id: `jobicy-${j.id}`,
      title: j.jobTitle,
      company: j.companyName,
      url: j.url,
      description: stripHtml(j.jobDescription || j.jobExcerpt),
      location: asText(j.jobGeo),
      level: asText(j.jobLevel),
      source: "Jobicy",
    })
  );
}

async function fetchTheMuse() {
  const location = encodeURIComponent("Flexible / Remote");
  const pages = await Promise.all(
    [1, 2].map((p) =>
      fetchJson(`https://www.themuse.com/api/public/jobs?page=${p}&location=${location}`, "The Muse")
    )
  );
  return pages
    .flatMap((d) => d?.results || [])
    .map((j) =>
      makeJob({
        id: `muse-${j.id}`,
        title: j.name,
        company: j.company?.name,
        url: j.refs?.landing_page,
        description: stripHtml(j.contents),
        location: asText((j.locations || []).map((l) => l.name)),
        level: asText((j.levels || []).map((l) => l.name)),
        source: "The Muse",
      })
    );
}

async function fetchWorkingNomads() {
  const data = await fetchJson("https://www.workingnomads.com/api/exposed_jobs/", "Working Nomads");
  if (!Array.isArray(data)) return [];
  return data.slice(0, 150).map((j) =>
    makeJob({
      id: `workingnomads-${j.url || j.title}`,
      title: j.title,
      company: j.company_name,
      url: j.url,
      description: stripHtml(`${j.description || ""} ${asText(j.tags)}`),
      location: j.location,
      source: "Working Nomads",
    })
  );
}

function xmlTag(chunk, name) {
  const m = chunk.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

async function fetchWeWorkRemotely() {
  try {
    const res = await fetch("https://weworkremotely.com/remote-jobs.rss", {
      headers: { "User-Agent": "job-radar-worker" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": SOURCE_CACHE_SECONDS, "400-599": 0 } },
    });
    if (!res.ok) {
      console.error(`We Work Remotely fetch failed: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    return xml
      .split("<item>")
      .slice(1, 101)
      .map((chunk) => {
        const fullTitle = xmlTag(chunk, "title");
        const sep = fullTitle.indexOf(": ");
        const company = sep > 0 ? fullTitle.slice(0, sep) : "";
        const title = sep > 0 ? fullTitle.slice(sep + 2) : fullTitle;
        const link = xmlTag(chunk, "link") || xmlTag(chunk, "guid");
        return makeJob({
          id: `wwr-${link}`,
          title,
          company,
          url: link,
          description: stripHtml(xmlTag(chunk, "description")),
          location: xmlTag(chunk, "region") || xmlTag(chunk, "country"),
          source: "We Work Remotely",
        });
      })
      .filter((j) => j.title && j.url);
  } catch (err) {
    console.error("We Work Remotely fetch failed:", err.message);
    return [];
  }
}

// In-person jobs in India via Adzuna (free App ID and Key).
async function fetchAdzunaIndia(roleType, city, env, perPage = 50) {
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) {
    console.error("Adzuna keys are missing; add ADZUNA_APP_ID and ADZUNA_APP_KEY secrets.");
    return [];
  }
  for (const term of hasKey(CITY_SEARCH_TERMS, city) ? CITY_SEARCH_TERMS[city] : []) {
    const what = roleType ? `&what=${encodeURIComponent(roleType)}` : "";
    const url =
      `https://api.adzuna.com/v1/api/jobs/in/search/1?app_id=${encodeURIComponent(env.ADZUNA_APP_ID)}` +
      `&app_key=${encodeURIComponent(env.ADZUNA_APP_KEY)}&results_per_page=${perPage}${what}` +
      `&where=${encodeURIComponent(term)}&content-type=application/json`;
    const data = await fetchJson(url, "Adzuna");
    const jobs = (data?.results || []).map((j) =>
      makeJob({
        id: `adzuna-${j.id}`,
        title: stripHtml(j.title),
        company: j.company?.display_name,
        url: j.redirect_url,
        description: stripHtml(j.description),
        location: j.location?.display_name || city,
        source: "Adzuna",
        roleTag: roleType,
        salaryMin: j.salary_min,
        salaryMax: j.salary_max,
        salaryPredicted: j.salary_is_predicted,
      })
    );
    if (jobs.length > 0) return jobs;
  }
  return [];
}

function stripHtml(html) {
  if (!html) return "";
  // Only the first part of long descriptions is needed for matching; this also keeps CPU use low.
  return String(html)
    .slice(0, 3000)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- Country filter, de-duplication and scoring ----------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesCountry(job, country) {
  if (!country) return true;
  const loc = (job.location || "").toLowerCase().trim();
  if (!loc) return true; // unknown location: keep it, the listing itself will say
  const own = [country.toLowerCase(), ...(COUNTRY_ALIASES[country] || [])];
  // "US only", "EU only" and similar restrictions must name the person's own region.
  const restricted = /\bonly\b/.test(loc);
  const words = restricted ? own : [...OPEN_LOCATION_WORDS, ...own];
  return words.some((w) => new RegExp(`(^|[^a-z])${escapeRegex(w)}([^a-z]|$)`).test(loc));
}

// Why saved jobs are switched off, or "" when they are on. A secret that exists but is blank counts as missing.
function savedJobsOffReason(env) {
  if (!env.DB) return "the D1 database is not connected (Settings > Bindings: add a D1 binding with the variable name DB, on Production)";
  if (typeof env.HASH_SECRET !== "string" || env.HASH_SECRET.trim() === "") {
    return "HASH_SECRET is missing or empty (Settings > Variables and secrets: add a Secret named HASH_SECRET with a long random value, then Deploy)";
  }
  return "";
}

// The same job is recognised by its link, or by title and company when it has none.
function jobKey(job) {
  return (job.url || `${job.title}|${job.company}`).toLowerCase();
}

function dedupeJobs(jobs) {
  const seen = new Set();
  return jobs.filter((j) => {
    const key = jobKey(j);
    if (!j.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- Scam filter ----------
// Drops listings with clear scam signals. The rules are deliberately narrow: loan, property and finance jobs
// legitimately mention fees and deposits, so a word like "fee" alone is never enough.

// Fees the applicant is asked to pay.
const SCAM_FEE_PHRASES = new RegExp(
  [
    "\\b(?:registration|joining)\\s+(?:fees?|charges?|amount)\\b",
    "\\brefundable\\s+(?:security\\s+)?(?:deposit|fee|amount)\\b",
    "\\b(?:laptop|kit|id card|uniform)\\s+(?:fees?|charges?|deposit)\\b",
    "\\bpay\\s+to\\s+apply\\b",
    "\\bpay\\s+for\\s+(?:the\\s+)?(?:job|joining|training)\\b",
    "\\b100\\s*%\\s*(?:job\\s*)?(?:guarantee|guaranteed|placement)\\b",
    "\\bjob\\s+guarantee\\b",
    "\\b(?:you|candidates?|applicants?)\\s+(?:have to|need to|must|will need to|will have to|are required to|should|would need to)\\s+(?:pay|deposit)\\b",
  ].join("|"),
  "gi"
);

// Applying or "contacting HR" only through WhatsApp or Telegram.
const SCAM_MESSAGING = new RegExp(
  [
    "\\b(?:apply|contact|reach|message|send|share|forward)\\b[^.]{0,45}\\b(?:on|via|through|over)\\s+(?:whatsapp|telegram)\\b",
    "\\b(?:whatsapp|telegram)\\s+(?:us|your\\s+(?:resume|cv)|hr|recruiter)\\b",
    "\\b(?:resume|cv)\\s+(?:on|to)\\s+(?:whatsapp|telegram)\\b",
  ].join("|"),
  "gi"
);

// Promises of big or guaranteed earnings, and well-known fake task jobs.
const SCAM_INCOME = new RegExp(
  [
    "\\bearn(?:ing|s)?\\s+(?:up\\s*to\\s+|upto\\s+|minimum\\s+)?(?:rs\\.?|\\u20B9|inr|usd|\\$)?\\s*\\d[\\d,]*\\s*k?\\s*(?:/|per|a|each)\\s*(?:day|daily|hour|hr|week)\\b",
    "\\b(?:daily|weekly)\\s+payouts?\\b",
    "\\bget\\s+paid\\s+daily\\b",
    "\\bguaranteed\\s+(?:income|earnings?)\\b",
    "\\bunlimited\\s+(?:income|earnings?)\\b",
    "\\bcaptcha\\s+(?:typing|entry|filling)\\b",
    "\\bcopy[- ]paste\\s+(?:jobs?|work)\\b",
    "\\bad[- ]posting\\s+(?:jobs?|work)\\b",
    "\\blike\\s+(?:and|&)\\s+subscribe\\b",
    "\\bclick(?:ing)?\\s+(?:on\\s+)?ads\\b",
  ].join("|"),
  "gi"
);

// "No registration fee" and "we never ask for money" are good signs, not scams.
const NEGATION_BEFORE = /\b(?:no|not|never|without|zero|free of|don't|do not|doesn't|does not)\b[^.]{0,30}$/i;

function hasScamMatch(text, regex) {
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 45), m.index);
    if (!NEGATION_BEFORE.test(before)) return true;
    if (m[0].length === 0) regex.lastIndex++;
  }
  return false;
}

// Returns why a listing looks like a scam, or "" if it doesn't.
function scamReason(job) {
  const text = `${job.title} ${job.description}`;
  if (hasScamMatch(text, SCAM_FEE_PHRASES)) return "asks the applicant for money";
  if (hasScamMatch(text, SCAM_MESSAGING)) return "contact only through WhatsApp or Telegram";
  if (hasScamMatch(text, SCAM_INCOME)) return "promises unrealistic earnings";
  return "";
}

function removeScams(jobs) {
  const kept = [];
  const blocked = [];
  for (const job of jobs) {
    const reason = scamReason(job);
    if (reason) blocked.push({ title: job.title, company: job.company, source: job.source, reason });
    else kept.push(job);
  }
  return { kept, blocked };
}

function countMatches(job, skills) {
  const haystack = `${job.title} ${job.description}`.toLowerCase();
  return skills.filter((skill) => {
    if (!skill) return false;
    // Very short skills like "r" or "c" must match as whole words, not inside other words.
    if (skill.length <= 2) {
      return new RegExp(`(^|[^a-z0-9])${escapeRegex(skill)}([^a-z0-9]|$)`).test(haystack);
    }
    return haystack.includes(skill);
  }).length;
}

// How well a job's title fits one role: 3 for the full role in the title, 1 for most of its words.
function singleRoleScore(job, role) {
  if (!role) return 0;
  const title = job.title.toLowerCase();
  const wanted = role.toLowerCase();
  if (title.includes(wanted)) return 3;
  const words = wanted.split(/[^a-z0-9+#]+/).filter((w) => w.length > 3);
  if (words.length === 0) return 0;
  const hits = words.filter((w) => title.includes(w)).length;
  return hits >= Math.ceil(words.length / 2) ? 1 : 0;
}

// With several roles, a job counts for the role it fits best.
function roleScore(job, roles) {
  return Math.max(0, ...(roles || []).map((r) => singleRoleScore(job, r)));
}

function pickTopJobs(jobs, skills, workType, roles, options = {}) {
  const { experience = "", salaryBand = "" } = options;

  const scored = jobs.map((job) => {
    const base = countMatches(job, skills) + roleScore(job, roles);
    const fit = workType === "onsite" && salaryBand ? salaryFit(job, salaryBand) : "unknown";
    // Listings inside the chosen salary band first, then listings with no salary shown.
    const salaryBonus = fit === "in" ? 2 : 0;
    return { ...job, baseScore: base, salaryFit: fit, matchCount: base + experienceScore(job, experience) + salaryBonus };
  });

  // Drop listings whose salary is clearly outside the chosen band; keep ones with no salary listed.
  const ranked = scored.filter((j) => j.salaryFit !== "out").sort((a, b) => b.matchCount - a.matchCount);

  if (workType === "onsite") {
    // Results come from one search per role, so take turns between roles to give each a fair share.
    const groups = new Map();
    for (const job of ranked) {
      if (!groups.has(job.roleTag)) groups.set(job.roleTag, []);
      groups.get(job.roleTag).push(job);
    }
    const lists = [...groups.values()];
    const picked = [];
    for (let i = 0; picked.length < MAX_RESULTS && lists.some((l) => i < l.length); i++) {
      for (const list of lists) {
        if (i < list.length && picked.length < MAX_RESULTS) picked.push(list[i]);
      }
    }
    return picked;
  }

  let picked = ranked.filter((j) => j.matchCount >= 2).slice(0, MAX_RESULTS);
  if (picked.length < 5) {
    // Too few strong matches: fill up with weaker matches rather than send a near-empty email.
    const extra = ranked.filter((j) => j.matchCount === 1).slice(0, MAX_RESULTS - picked.length);
    picked = picked.concat(extra);
  }
  if (picked.length < 3) {
    // Experience level should never leave the email empty: fall back to skill and role fit alone.
    const taken = new Set(picked.map((j) => j.id));
    const extra = [...ranked]
      .sort((a, b) => b.baseScore - a.baseScore)
      .filter((j) => j.baseScore >= 1 && !taken.has(j.id))
      .slice(0, 3 - picked.length);
    picked = picked.concat(extra);
  }
  return picked;
}

// Gmail requires a short-lived access token, obtained fresh each time using the
// long-lived refresh token (from the one-time OAuth Playground exchange).
async function getGmailAccessToken(clientId, clientSecret, refreshToken) {
  // Trim stray spaces/newlines that can sneak in when pasting secrets.
  clientId = (clientId || "").trim();
  clientSecret = (clientSecret || "").trim();
  refreshToken = (refreshToken || "").trim();

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Gmail token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

// Base64url-encode a string (Gmail's API requires base64url, not standard base64).
function base64UrlEncode(str) {
  // btoa works on strings; the HTML body may contain unicode (e.g. em dash),
  // so we first UTF-8 encode it before base64-encoding.
  const utf8Bytes = new TextEncoder().encode(str);
  let binary = "";
  utf8Bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendEmail(env, toEmail, jobs, resumeSummary, searchLabel, searchLinks = [], extras = {}) {
  const html = buildEmailHtml(jobs, resumeSummary, searchLabel, searchLinks, extras);
  const subject =
    jobs.length > 0
      ? `Job Radar: ${jobs.length} ${extras.onlyNew ? "new " : ""}matches for you`
      : extras.nothingNew
        ? "Job Radar: nothing new this time"
        : "Job Radar: no matches this run";

  await deliverEmail(env, toEmail, subject, html);
}

// Sends one HTML email through the Gmail API.
async function deliverEmail(env, toEmail, subject, html) {
  const accessToken = await getGmailAccessToken(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
    env.GMAIL_REFRESH_TOKEN
  );

  // Build a raw RFC 2822 email message (Gmail's API wants this, base64url-encoded).
  const rawMessage =
    `From: Job Radar <${env.GMAIL_SENDER_EMAIL}>\r\n` +
    `To: ${toEmail}\r\n` +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset="UTF-8"\r\n\r\n` +
    html;

  const encodedMessage = base64UrlEncode(rawMessage);

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encodedMessage }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
  }
}


const SOURCE_LINKS = {
  Remotive: "https://remotive.com",
  RemoteOK: "https://remoteok.com",
  Arbeitnow: "https://www.arbeitnow.com",
  Himalayas: "https://himalayas.app",
  Jobicy: "https://jobicy.com",
  "The Muse": "https://www.themuse.com",
  "Working Nomads": "https://www.workingnomads.com",
  "We Work Remotely": "https://weworkremotely.com",
  Adzuna: "https://www.adzuna.in",
};

function safeUrl(u) {
  return /^https?:\/\//i.test(u || "") ? u : "#";
}

// "Fit 4/5" and, when known, what the listing asks for that the candidate's skills don't mention.
function fitLineHtml(job) {
  if (!job.fit) return "";
  const colours = job.fit >= 4 ? ["#ecfdf5", "#065f46"] : job.fit === 3 ? ["#fffbeb", "#92400e"] : ["#f3f4f6", "#4b5563"];
  const gap = job.gap ? ` <span style="color:#92400e;font-size:13px;">Gap: ${escapeHtml(job.gap)}</span>` : "";
  return `<p style="margin:0 0 8px;"><span style="display:inline-block;padding:2px 9px;border-radius:10px;background:${colours[0]};color:${colours[1]};font-size:13px;font-weight:600;">Fit ${job.fit}/5</span>${gap}</p>`;
}

function adzunaLabelHtml() {
  return `<p style="margin:10px 0 0;font-size:12px;color:#666;"><a href="https://www.adzuna.in" style="color:#666;text-decoration:none;">Jobs</a> by <a href="https://www.adzuna.in"><img src="${ADZUNA_LOGO_URL}" alt="Adzuna" height="23" style="vertical-align:middle;border:0;"></a></p>`;
}

function buildSearchLinksHtml(searchLinks) {
  if (!searchLinks || searchLinks.length === 0) return "";
  const rows = searchLinks
    .map((entry) => {
      const links = entry.links
        .map((l) => `<a href="${escapeHtml(safeUrl(l.url))}" style="color:#2563eb;">${escapeHtml(l.name)}</a>`)
        .join(" &middot; ");
      return `<p style="margin:0 0 6px;">${escapeHtml(entry.role)}: ${links}</p>`;
    })
    .join("");
  return `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2e2e2;">
      <h3 style="margin:0 0 8px;font-size:15px;">Search more</h3>
      ${rows}
      <p style="margin:6px 0 0;color:#999;font-size:12px;">These open the same search on other job sites. Their results are not checked by Job Radar.</p>
    </div>`;
}

// The email sent when someone asks for a link to their saved jobs.
function buildLinkEmailHtml(links) {
  if (!links) {
    return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2>Job Radar</h2>
      <p>Someone asked for the saved jobs for this email address, but nothing is saved. Job Radar only remembers jobs if you tick "Remember the jobs you send me" when you search.</p>
      <p style="color:#666;font-size:12px;">If you didn't ask for this, you can ignore it.</p>
    </div>`;
  }
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
    <h2>Job Radar</h2>
    <p>Here are the links to your saved jobs.</p>
    ${buildSavedBoxHtml(links)}
    <p style="color:#666;font-size:12px;">If you didn't ask for this, you can ignore it. Please don't share this email: anyone with these links can use them.</p>
  </div>`;
}

// A clearly visible box with two buttons to view or delete the saved jobs.
function buildSavedBoxHtml(extras) {
  if (!(extras.viewUrl && extras.deleteUrl)) return "";
  return `<div style="margin:16px 0;padding:14px 16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
      <p style="margin:0 0 4px;font-weight:600;color:#1e3a8a;">Your saved jobs</p>
      <p style="margin:0 0 12px;color:#334155;font-size:14px;">We keep the jobs we send you for ${HISTORY_DAYS} days, so you don't get repeats.</p>
      <a href="${escapeHtml(extras.viewUrl)}" style="display:inline-block;padding:9px 16px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">View my saved jobs</a>
      <a href="${escapeHtml(extras.deleteUrl)}" style="display:inline-block;margin-left:8px;padding:8px 15px;border:1px solid #94a3b8;color:#334155;border-radius:6px;text-decoration:none;font-size:14px;">Delete my data</a>
    </div>`;
}

// A line saying nothing was saved, for people who did not ask us to remember.
function buildHistoryHtml(extras) {
  if (extras.notSaved) {
    return `<p style="color:#666;font-size:12px;margin-top:16px;">This search was not saved.</p>`;
  }
  return "";
}

function buildEmailHtml(jobs, resumeSummary, searchLabel, searchLinks = [], extras = {}) {
  const intro =
    (resumeSummary
      ? `<p style="color:#555;">Based on your resume: <em>${escapeHtml(resumeSummary)}</em></p>`
      : "") +
    (searchLabel ? `<p style="color:#555;">Showing ${escapeHtml(searchLabel)}.</p>` : "");

  if (jobs.length === 0) {
    return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2>Job Radar</h2>
      ${intro}
      ${buildSavedBoxHtml(extras)}
      ${
        extras.nothingNew
          ? "<p>Nothing new since your last search: every job that matches was already sent to you. Check back later, or open your saved list below.</p>"
          : "<p>No matching jobs found this time. Try different skills, another role, or a wider salary range or experience level.</p>"
      }
      ${buildSearchLinksHtml(searchLinks)}
      ${buildHistoryHtml(extras)}
    </div>`;
  }

  const jobCards = jobs
    .map((j) => {
      const meta = [j.company, j.location, formatSalary(j), j.source].filter(Boolean).map(escapeHtml).join(" &middot; ");
      return `
      <div style="border:1px solid #e2e2e2;border-radius:8px;padding:16px;margin-bottom:12px;">
        <h3 style="margin:0 0 4px;"><a href="${escapeHtml(safeUrl(j.url))}" style="color:#2563eb;text-decoration:none;">${escapeHtml(j.title)}</a></h3>
        <p style="margin:0 0 8px;color:#666;">${meta}</p>
        ${fitLineHtml(j)}
        ${j.blurb ? `<p style="margin:0;color:#333;">${escapeHtml(j.blurb)}</p>` : ""}
        ${j.source === "Adzuna" ? adzunaLabelHtml() : ""}
      </div>`;
    })
    .join("");

  // Several sources ask for a visible credit, so list every source that appears in this email.
  const used = Array.from(new Set(jobs.map((j) => j.source)));
  const credits = used
    .map((s) => {
      const link = `<a href="${SOURCE_LINKS[s] || "#"}" style="color:#999;">${escapeHtml(s)}</a>`;
      return s === "Adzuna" ? `Jobs by ${link}` : link;
    })
    .join(", ");

  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
    <h2>Job Radar: Your Matches</h2>
    ${intro}
    ${buildSavedBoxHtml(extras)}
    ${extras.onlyNew ? `<p style="color:#555;">Showing only jobs we haven't sent you before.</p>` : ""}
    ${jobCards}
    ${buildSearchLinksHtml(searchLinks)}
    ${buildHistoryHtml(extras)}
    ${jobs.some((j) => j.fit) ? '<p style="color:#666;font-size:12px;margin-top:20px;">Fit scores are an AI estimate from your skills and the listing text, not a promise. Please check each listing yourself.</p>' : ""}
    <p style="color:#b45309;font-size:12px;margin-top:20px;">Stay safe: a real employer never charges you to apply or asks for bank details, OTPs or money to start work. Job Radar removes listings with obvious scam signs but cannot catch every one.</p>
    <p style="color:#999;font-size:12px;margin-top:12px;">Listings from: ${credits}. Sent automatically by Job Radar.</p>
  </div>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
