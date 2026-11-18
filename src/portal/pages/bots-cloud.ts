// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The bots page's cloud bot parts (pages/bots.ts; docs/cloud-bots.md): the fields a cloud bot has
 * in New bot and Edit, and the script that fills and reads them.
 */

/**
 * A cloud bot's own fields (New bot and Edit, prefixed so the two forms' ids differ): compute, web,
 * a UTC schedule, and GitHub (repository, token, triggers). The token field is write-only: the page
 * never gets the token back, only whether one is stored.
 */
export function CLOUD_FIELDS(p: string): string {
  return `
            <label>Compute<select name="cloudCompute" id="${p}CloudCompute"><option value="auto">Auto: my machines first, then the network</option></select><span class="hint">Your own machines are free; the network is billed in cSats.</span></label>
            <label class="check"><input type="checkbox" name="cloudWeb" checked />Search the web (billed per search and page)</label>
            <div><span class="u-fs-12">Schedule (UTC)</span>
              <div class="sched">
                <select name="cloudSchedKind" id="${p}CloudSched" aria-label="Schedule"><option value="">No schedule: messages and triggers only</option><option value="every">Every …</option><option value="daily">Daily at … (UTC)</option></select>
                <input name="cloudEvery" type="number" min="15" max="10080" step="5" value="60" aria-label="Every how many minutes" />
                <input name="cloudDaily" type="time" value="09:00" aria-label="Time of day, UTC" />
              </div>
            </div>
            <label>GitHub repository (optional)<input name="cloudRepo" maxlength="140" placeholder="owner/repo" autocomplete="off" /><span class="hint" id="${p}CloudGhHint">Read files, comment, and open pull requests from a new branch. Never the default branch or .github/.</span></label>
            <label>GitHub token<input name="cloudToken" type="password" maxlength="400" autocomplete="off" spellcheck="false" placeholder="A fine-grained token for this repository" /><span class="hint" id="${p}CloudTokenHint">Kept encrypted; never shown again. Give it only this repository's contents, issues and pull requests.</span></label>
            <fieldset class="u-m-0" id="${p}CloudTriggers" disabled><legend>GitHub triggers</legend>
              <span class="hint" id="${p}CloudTriggersHint">Add a repository to use triggers</span>
              <label class="trig"><input type="checkbox" name="cTrigPr" />PR opened by others</label>
              <label class="trig"><input type="checkbox" name="cTrigCi" />CI failed</label>
              <label class="trig"><input type="checkbox" name="cTrigIssue" />Issue labeled<input name="cTrigIssueLabel" class="trig-label" maxlength="50" placeholder="bot" aria-label="Issue label" /></label>
            </fieldset>`;
}

/** Plain JS for the page (String.raw keeps its backslashes); uses the page's api, escapeHtml, setText, listState and state. */
export const CLOUD_BOTS_PAGE_JS = String.raw`
    /* The compute picker for cloud bots: Auto, then your machines' models (free) and the network's. */
    var computeOptionsCache = null;
    async function loadCloudCompute(selectId, selected) {
      var sel = document.getElementById(selectId);
      function fill(list) {
        var opts = [["auto", "Auto: my machines first, then the network"]];
        list.forEach(function(o) {
          if (!o.compute || (o.group !== "mine" && o.group !== "network")) return;
          if (o.group === "network" && o.compute.computeClass && o.compute.computeClass !== "any") return;
          var v = (o.group === "mine" ? "mine:" : "network:") + o.compute.model;
          if (!opts.some(function(x) { return x[0] === v; })) opts.push([v, o.label + (o.detail ? " · " + o.detail : "")]);
        });
        if (selected && !opts.some(function(x) { return x[0] === selected; })) opts.push([selected, selected.replace(/^mine:/, "My machines · ").replace(/^network:/, "Network · ")]);
        sel.innerHTML = opts.map(function(o) { return '<option value="' + escapeHtml(o[0]) + '"' + (o[0] === selected ? " selected" : "") + ">" + escapeHtml(o[1]) + "</option>"; }).join("");
      }
      fill(computeOptionsCache || []);
      if (computeOptionsCache) return;
      try { var r = await api("/portal/api/compute/options", { method: "GET", headers: {} }); computeOptionsCache = r.options || []; fill(computeOptionsCache); } catch {}
    }
    /* Cloud fields (prefix bn or bpe): what's enabled follows the repository and the server's GitHub setup. */
    function cloudFieldsChanged(f, p) {
      var kind = f.cloudSchedKind.value;
      f.cloudEvery.hidden = kind !== "every";
      f.cloudDaily.hidden = kind !== "daily";
      var gh = listState.cloudGithub || (state.bot && state.bot.cloud && state.bot.cloud.github ? state.bot.cloud.github.available : false);
      var hasRepo = !!f.cloudRepo.value.trim();
      f.cloudToken.disabled = !gh;
      document.getElementById(p + "CloudTriggers").disabled = !hasRepo || !gh;
      document.getElementById(p + "CloudTriggersHint").hidden = hasRepo && gh;
      setText(p + "CloudTriggersHint", gh ? "Add a repository to use triggers" : "GitHub for cloud bots isn't set up on this server yet.");
    }
    function cloudSpec(f, keepToken) {
      var bot = { compute: f.cloudCompute.value || "auto", web: !!f.cloudWeb.checked };
      var kind = f.cloudSchedKind.value;
      bot.schedule = kind === "every" ? { everyMinutes: Number(f.cloudEvery.value) } : kind === "daily" ? { dailyAtUtc: f.cloudDaily.value } : null;
      var repo = f.cloudRepo.value.trim();
      if (repo) {
        var tr = [];
        if (f.cTrigPr.checked) tr.push({ kind: "pr_opened" });
        if (f.cTrigCi.checked) tr.push({ kind: "ci_failed" });
        if (f.cTrigIssue.checked) tr.push({ kind: "issue_labeled", label: f.cTrigIssueLabel.value.trim() || "bot" });
        bot.github = { repo: repo, triggers: tr };
        var token = f.cloudToken.value.trim();
        if (token) bot.github.token = token;
        else if (!keepToken) delete bot.github.token;
      } else bot.github = null;
      return bot;
    }
    function cloudCheck(f) {
      if (f.cloudSchedKind.value === "every" && !(Number(f.cloudEvery.value) >= 15)) return "A schedule runs at most every 15 minutes.";
      if (f.cloudSchedKind.value === "daily" && !/^\d\d:\d\d$/.test(f.cloudDaily.value)) return "Pick a time of day (UTC).";
      var repo = f.cloudRepo.value.trim();
      if (repo && !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repo)) return "The repository is owner/repo.";
      return "";
    }    /* Edit: a cloud bot's settings into the form (the token field stays empty: it's never sent back). */
    function fillCloudEdit(b, f) {
        var c = b.cloud || {};
        loadCloudCompute("bpeCloudCompute", c.compute || "auto");
        f.cloudWeb.checked = c.web !== false;
        var s = c.schedule || null;
        f.cloudSchedKind.value = s && s.everyMinutes ? "every" : s && s.dailyAtUtc ? "daily" : "";
        if (s && s.everyMinutes) f.cloudEvery.value = s.everyMinutes;
        if (s && s.dailyAtUtc) f.cloudDaily.value = s.dailyAtUtc;
        var g = c.github || null, trig = (g && g.triggers) || [];
        f.cloudRepo.value = g ? g.repo : "";
        f.cloudToken.value = "";
        f.cloudToken.placeholder = g && g.hasToken ? "A token is stored: leave empty to keep it" : "A fine-grained token for this repository";
        function has(k) { return trig.find(function(t) { return t.kind === k && t.enabled; }); }
        f.cTrigPr.checked = !!has("pr_opened"); f.cTrigCi.checked = !!has("ci_failed"); f.cTrigIssue.checked = !!has("issue_labeled");
        f.cTrigIssueLabel.value = has("issue_labeled") ? has("issue_labeled").label || "" : "";
        f.budgetCSatsPerRun.value = c.limits ? c.limits.budgetCSatsPerRun : "";
        f.maxRunsPerDay.value = b.maxRunsPerDay;
        f.budgetCSatsPerDay.value = b.budgetCSatsPerDay == null ? "" : b.budgetCSatsPerDay;
    }
`;
