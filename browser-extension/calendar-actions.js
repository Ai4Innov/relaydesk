(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RelayCalendarActions = api;
})(globalThis, function () {
  "use strict";
  const excluded = "[contenteditable], [data-event-description], .NI2kfb, [data-event-location], [data-attendee], [role='listbox']";
  const labels = {
    title: /^(?:Title|Add title|Event title|Titre|Ajouter un titre|Titre de l'événement)$/i,
    startDate: /^(?:Start date|Date de début)$/i,
    endDate: /^(?:End date|Date de fin)$/i,
    startTime: /^(?:Start time|Heure de début)$/i,
    endTime: /^(?:End time|Heure de fin)$/i,
    recurrence: /^(?:Does not repeat|Ne se répète pas|Non récurrent)$/i,
    save: /^(?:Save|Enregistrer)$/i,
    edit: /^(?:Edit event|Modifier l'événement|Modifier l’événement)$/i,
    zone: /^(?:Time zone|Time zones|Fuseau horaire|Fuseaux horaires)$/i,
    cancel: /^(?:Cancel|Annuler)$/i,
    allDay: /^(?:All day|Toute la journée|Journée entière)$/i,
    saved: /^(?:Event saved|Événement enregistré|Evénement enregistré)[.!]?$/i
  };
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function name(node) {
    const explicit = node.getAttribute("aria-label");
    if (explicit) return clean(explicit);
    const refs = (node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (refs.length) return clean(refs.map(id => node.ownerDocument.getElementById(id)?.textContent || "").join(" "));
    if (node.labels?.length) return clean([...node.labels].map(label => label.textContent).join(" "));
    return clean(node.getAttribute("placeholder") || node.textContent);
  }
  function controls(scope, selector, visible) {
    return [...scope.querySelectorAll(selector)].filter(node => visible(node) && !node.closest(excluded));
  }
  function unique(list) { return list.length === 1 ? list[0] : undefined; }
  function button(scope, pattern, visible) {
    return unique(controls(scope, "button, [role='button']", visible).filter(node =>
      pattern.test(name(node)) && !node.disabled && node.getAttribute("aria-disabled") !== "true"));
  }
  function input(scope, pattern, visible) {
    return unique(controls(scope, "input", visible).filter(node =>
      pattern.test(name(node)) && !node.disabled && !node.readOnly));
  }
  function nativeInput(scope, id, pattern, visible) {
    const known = controls(scope, `input[id='${id}']`, visible).filter(node => !node.disabled && !node.readOnly);
    return known.length ? unique(known) : input(scope, pattern, visible);
  }
  function parseTime(value) {
    const text = clean(value).toLowerCase().replace(/\./g, "");
    const match = /^(\d{1,2})(?::|h)(\d{2})\s*(am|pm)?$/.exec(text);
    if (!match) {
      const hourOnly = /^(\d{1,2})\s*(am|pm)$/.exec(text);
      if (!hourOnly) return undefined;
      return parseTime(`${hourOnly[1]}:00${hourOnly[2]}`);
    }
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    if (minute > 59 || hour > (match[3] ? 12 : 23) || (match[3] && hour === 0)) return undefined;
    if (match[3]) hour = hour % 12 + (match[3] === "pm" ? 12 : 0);
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  function dateCodec(node, language) {
    const value = clean(node.value);
    if (node.type === "date" || /^\d{4}-\d{2}-\d{2}$/.test(value))
      return { format: date => date, parse: text => /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined };
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const shortMonths = monthNames.map(month => month.slice(0, 3));
    const wordDate = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(value);
    if (wordDate && /^(?:en)(?:-|$)/i.test(language)) {
      const monthIndex = monthNames.findIndex(month => month.toLowerCase() === wordDate[2].toLowerCase() ||
        month.slice(0, 3).toLowerCase() === wordDate[2].toLowerCase() ||
        (month === "September" && wordDate[2].toLowerCase() === "sept"));
      if (monthIndex >= 0) {
        const full = wordDate[2].length > 4;
        if (wordDate[2].toLowerCase() === "sept") shortMonths[8] = "Sept";
        return {
          format: date => {
            const [year, month, day] = date.split("-");
            return `${Number(day)} ${(full ? monthNames : shortMonths)[Number(month) - 1]} ${year}`;
          },
          parse: text => {
            const parts = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(clean(text));
            if (!parts) return undefined;
            const month = monthNames.findIndex(name => name.toLowerCase() === parts[2].toLowerCase() ||
              name.slice(0, 3).toLowerCase() === parts[2].toLowerCase() ||
              (name === "September" && parts[2].toLowerCase() === "sept"));
            return month < 0 ? undefined : `${parts[3]}-${String(month + 1).padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
          }
        };
      }
    }
    const numeric = /^(\d{1,2})([/.])(\d{1,2})\2(\d{4})$/.exec(value);
    const french = /^fr(?:-|$)/i.test(language);
    const american = /^en-US$/i.test(language);
    const british = /^en-GB$/i.test(language);
    if (numeric && (french || american || british)) {
      const dayFirst = !american;
      const separator = numeric[2];
      return {
        format: date => {
          const [year, month, day] = date.split("-");
          return `${dayFirst ? day : month}${separator}${dayFirst ? month : day}${separator}${year}`;
        },
        parse: text => {
          const parts = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(clean(text));
          if (!parts) return undefined;
          return `${parts[3]}-${(dayFirst ? parts[2] : parts[1]).padStart(2, "0")}-${(dayFirst ? parts[1] : parts[2]).padStart(2, "0")}`;
        }
      };
    }
    // Match the actual displayed locale template; never ask Date.parse to guess ambiguous dates.
    if (/^(?:en|fr)(?:-|$)/i.test(language)) {
      for (const month of ["short", "long"]) {
        const formatter = new Intl.DateTimeFormat(language, { year: "numeric", month, day: "numeric", timeZone: "UTC" });
        const format = date => formatter.format(new Date(`${date}T12:00:00Z`));
        const parse = text => {
          const year = /\b(20\d{2}|19\d{2})\b/.exec(text)?.[1];
          if (!year) return undefined;
          for (let m = 1; m <= 12; m++) for (let d = 1; d <= 31; d++) {
            const date = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
            if (clean(format(date)).toLowerCase() === clean(text).toLowerCase()) return date;
          }
          return undefined;
        };
        if (parse(value)) return { format, parse };
      }
    }
    return undefined;
  }
  function setValue(node, value) {
    const view = node.ownerDocument.defaultView;
    const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value").set;
    node.focus();
    setter.call(node, value);
    node.dispatchEvent(new view.Event("input", { bubbles: true }));
    node.dispatchEvent(new view.Event("change", { bubbles: true }));
    node.blur();
  }
  function timeText(node, value) {
    const suffix = /(\s?)(am|pm)$/i.exec(clean(node.value));
    if (!suffix) return value;
    const [hour, minute] = value.split(":");
    const period = Number(hour) >= 12 ? "pm" : "am";
    return `${Number(hour) % 12 || 12}:${minute}${suffix[1]}${suffix[2] === suffix[2].toUpperCase() ? period.toUpperCase() : period}`;
  }
  function selectedZone(node) {
    // Only exact, geographically explicit labels observed in Google's own picker.
    // Never infer a zone from a GMT offset or search the unselected options.
    const knownLabels = new Map([
      ["lagos, nigeria west africa time - lagos (gmt+01:00)", "Africa/Lagos"],
      ["nairobi, kenya east africa time (gmt+03:00)", "Africa/Nairobi"]
    ]);
    const raw = clean(node.value || node.getAttribute("data-value") || node.getAttribute("aria-valuetext"));
    const value = knownLabels.get(raw.toLowerCase()) || raw;
    if (node.tagName === "SELECT" && node.selectedOptions.length === 1) {
      const selected = knownLabels.get(clean(node.selectedOptions[0].label).toLowerCase());
      if (selected && value.includes("/") && selected !== value) return "";
      if (selected && !value.includes("/")) return selected;
    }
    return value;
  }
  async function execute(job, environment) {
    const { document, extractors, authorize } = environment;
    const visible = extractors.visible;
    const url = environment.url || (() => document.location.href);
    const sleep = environment.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const move = job?.move;
    let saveClicked = false;
    let userIntervened = false;
    const onUserInput = event => { if (event.isTrusted) userIntervened = true; };
    for (const type of ["pointerdown", "keydown", "input", "change"]) document.addEventListener(type, onUserInput, true);
    function fail(code) { throw Object.assign(new Error(code), { calendarCode: code }); }
    function identity() {
      if (userIntervened) fail("event-changed");
      if (document.visibilityState !== "visible") fail("busy");
      let current;
      try { current = extractors.identity(document, url()); } catch { fail("account-mismatch"); }
      if (current.kind !== "calendar" || current.accountEmail !== move.accountEmail.toLowerCase()) fail("account-mismatch");
      if (Date.parse(move.expiresAt) <= Date.now()) fail("expired");
      return current;
    }
    async function wait(check, timeout = 4000) {
      const deadline = Date.now() + timeout;
      do {
        const value = check();
        if (value) return value;
        await sleep(80);
      } while (Date.now() < deadline);
      return undefined;
    }
    function eventChip() {
      return unique(controls(document, "[role='main'] [data-eventid]", visible)
        .filter(node => node.getAttribute("data-eventid") === move.providerId && !node.closest("[role='dialog']")));
    }
    function editor() {
      const title = nativeInput(document, "xTiIn", labels.title, visible);
      const scope = title?.closest("[role='main'], [role='dialog'], form");
      if (!scope) return undefined;
      const fields = { title, startDate: nativeInput(scope, "xStDaIn", labels.startDate, visible),
        endDate: nativeInput(scope, "xEnDaIn", labels.endDate, visible),
        startTime: nativeInput(scope, "xStTiIn", labels.startTime, visible),
        endTime: nativeInput(scope, "xEnTiIn", labels.endTime, visible) };
      return Object.values(fields).every(Boolean) ? { scope, ...fields } : undefined;
    }
    function saveButton(form) {
      const known = controls(document, "button[id='xSaveBu'], [role='button'][id='xSaveBu']", visible)
        .filter(node => labels.save.test(name(node)) && !node.disabled && node.getAttribute("aria-disabled") !== "true");
      return known.length ? unique(known) : button(form.scope, labels.save, visible);
    }
    function assertEditor(form) {
      if (clean(form.title.value) !== clean(move.expectedTitle)) fail("event-changed");
      const allDay = controls(form.scope, "input[type='checkbox'], [role='checkbox']", visible)
        .filter(node => labels.allDay.test(name(node)));
      if (allDay.length !== 1 || allDay[0].checked || allDay[0].getAttribute("aria-checked") === "true") fail("unsupported-editor");
      const recurrence = controls(form.scope, "button, [role='button'], [role='combobox'], [role='group'], select", visible)
        .filter(node => labels.recurrence.test(name(node)) || labels.recurrence.test(clean(node.value)));
      if (recurrence.filter(node => !recurrence.some(parent => parent !== node && parent.contains(node))).length !== 1)
        fail("recurring-event");
      if (!saveButton(form)) fail("permission-denied");
    }
    function zoneValues(scope) {
      return controls(scope, "select, input, [role='combobox']", visible)
        .filter(node => /(?:time zone|fuseau horaire)/i.test(name(node)))
        .map(node => ({ name: name(node), value: selectedZone(node) }));
    }
    async function verifyZone(form) {
      const matches = values => {
        if (!values.length || values.length > 2 || values.some(zone => zone.value !== move.timeZone)) return false;
        if (values.length === 1) return /^(?:Event time zone|Time zone|Fuseau horaire(?: de l['’]événement)?)$/i.test(values[0].name);
        return values.some(zone => /(?:start|début)/i.test(zone.name)) && values.some(zone => /(?:end|fin)/i.test(zone.name));
      };
      const existing = zoneValues(form.scope);
      if (matches(existing)) return;
      if (existing.length) fail("time-zone-unverified");
      const opener = button(form.scope, labels.zone, visible);
      if (!opener) fail("time-zone-unverified");
      opener.click();
      const picker = await wait(() => unique(controls(document, "[role='dialog']", visible)
        .filter(node => node !== form.scope && zoneValues(node).length)));
      if (!picker || !matches(zoneValues(picker))) fail("time-zone-unverified");
      const cancel = button(picker, labels.cancel, visible);
      if (!cancel) fail("time-zone-unverified");
      cancel.click();
      if (!await wait(() => !visible(picker))) fail("time-zone-unverified");
    }
    function codecs(form) {
      const language = document.documentElement.lang || document.defaultView.navigator.language;
      const start = dateCodec(form.startDate, language), end = dateCodec(form.endDate, language);
      if (!start || !end || !parseTime(form.startTime.value) || !parseTime(form.endTime.value)) fail("unsupported-editor");
      return { start, end };
    }
    function exact(form, codec) {
      return codec.start.parse(form.startDate.value) === move.newDate && codec.end.parse(form.endDate.value) === move.newDate
        && parseTime(form.startTime.value) === move.startTime && parseTime(form.endTime.value) === move.endTime
        && clean(form.title.value) === clean(move.expectedTitle);
    }
    async function openEditor(chip) {
      chip.click();
      let form = await wait(() => editor() || unique(controls(document, "[role='dialog']", visible)), 3000);
      if (form?.scope) return form;
      if (!form) fail("unsupported-editor");
      const edit = button(form, labels.edit, visible);
      if (!edit) fail("permission-denied");
      identity();
      edit.click();
      form = await wait(editor);
      if (!form) fail("unsupported-editor");
      return form;
    }
    try {
      if (!move || job.protocol !== 1 || !/^[a-f0-9]{32}$/.test(job.requestId) ||
          !/^[a-f0-9]{64}$/.test(job.lease) || !/^\d{4}-\d{2}-\d{2}$/.test(move.newDate) ||
          !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(move.startTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(move.endTime) ||
          move.startTime >= move.endTime || move.notificationPolicy !== "provider-default") fail("unsupported-editor");
      identity();
      if (controls(document, "[role='dialog']", visible).length || nativeInput(document, "xTiIn", labels.title, visible) ||
          /(?:eventedit|\/edit)(?:\/|$)/.test(new URL(url()).pathname)) fail("busy");
      const chip = eventChip();
      if (!chip) fail("event-not-found");
      const captured = extractors.calendar(document, url()).meetings.find(item => item.id === move.providerId);
      if (!captured || clean(captured.whenText) !== clean(move.expectedWhenText))
        fail("event-changed");
      let form = await openEditor(chip);
      identity();
      assertEditor(form);
      await verifyZone(form);
      const codec = codecs(form);
      setValue(form.startDate, codec.start.format(move.newDate));
      setValue(form.endDate, codec.end.format(move.newDate));
      setValue(form.startTime, timeText(form.startTime, move.startTime));
      setValue(form.endTime, timeText(form.endTime, move.endTime));
      await sleep(150);
      if (!exact(form, codec)) fail("unsupported-editor");
      assertEditor(form);
      await verifyZone(form);
      identity();
      const permission = await authorize(identity());
      if (!permission || permission.authorized !== true || permission.requestId !== job.requestId ||
          !Number.isFinite(permission.expiresAt) || permission.expiresAt <= Date.now() ||
          permission.expiresAt > Date.now() + 1600) fail("authorization-denied");
      identity();
      if (!exact(form, codec)) fail("event-changed");
      assertEditor(form);
      const save = saveButton(form);
      const previousToasts = new Set(controls(document, "[role='status'], [role='alert']", visible)
        .filter(node => labels.saved.test(clean(node.textContent))));
      if (permission.expiresAt <= Date.now()) fail("authorization-denied");
      saveClicked = true;
      save.click();
      const outcome = await wait(() => {
        const dialogs = controls(document, "[role='dialog']", visible).filter(node => node !== form.scope);
        if (dialogs.length) return "notification-confirmation";
        const toast = controls(document, "[role='status'], [role='alert']", visible)
          .some(node => !previousToasts.has(node) && labels.saved.test(clean(node.textContent)));
        return toast && !editor() ? "saved" : undefined;
      }, 6000);
      if (outcome !== "saved") return { code: outcome || "save-unverified" };
      identity();
      // A toast alone is insufficient: reopen the exact provider event and read the persisted fields.
      const savedChip = eventChip();
      if (!savedChip) return { code: "save-unverified" };
      form = await openEditor(savedChip);
      identity();
      assertEditor(form);
      if (!exact(form, codecs(form))) return { code: "save-unverified" };
      await verifyZone(form);
      identity();
      if (!exact(form, codecs(form))) return { code: "save-unverified" };
      return { code: "saved" };
    } catch (error) {
      return { code: saveClicked ? "save-unverified" : error.calendarCode || "unsupported-editor" };
    } finally {
      for (const type of ["pointerdown", "keydown", "input", "change"]) document.removeEventListener(type, onUserInput, true);
    }
  }
  return { execute, parseTime, dateCodec };
});
