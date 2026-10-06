/* La clave vive en memoria. Ningun dato del ciudadano se interpreta como HTML. */
(() => {
  const $ = id => document.getElementById(id);
  const api = new URL("../../api/v1/admin/conversations", location.href).pathname;
  let token = "", access = 0, listRequest = 0, filters = "", cursor = null, pages = [null], page = 0, selected = null;
  const pending = new Set();
  const dates = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
  const dateText = value => value ? dates.format(new Date(value)) : "—";
  const notices = {
    unauthorized: "La clave no es válida o cambió. Ingresa de nuevo.",
    admin_not_configured: "El panel necesita una clave de administración configurada en el servidor.",
    persistence_not_configured: "El servidor aún no tiene configurado el acceso a la base de datos.",
    persistence_unavailable: "No pudimos consultar la base de datos. Revisa la conexión del servidor e inténtalo de nuevo.",
    invalid_filters: "Revisa los filtros: la fecha final debe ser igual o posterior a la inicial.",
    rate_limited: "Has realizado varias consultas seguidas. Espera un minuto e inténtalo de nuevo.",
    export_too_large: "Hay más de 10.000 chats en esta selección. Reduce el rango de fechas para descargarlos.",
    conversation_not_found: "Este chat ya no está disponible. Actualiza la lista."
  };
  const notify = (text = "", error = false) => {
    $("notice").textContent = text; $("notice").hidden = !text; $("notice").classList.toggle("error", error);
  };
  const logout = () => {
    token = ""; access++; selected = null;
    for (const controller of pending) controller.abort();
    pending.clear(); $("workspace").hidden = $("logout").hidden = true; $("login").hidden = false;
    $("token").value = ""; $("records").replaceChildren(); $("metadata").replaceChildren(); $("messages").replaceChildren();
    $("detail").hidden = $("json").hidden = true; $("detail-empty").hidden = false; $("token").focus();
  };
  const request = async path => {
    const generation = access, controller = new AbortController(); pending.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(api + path, { headers: { Authorization: "Bearer " + token }, cache: "no-store", signal: controller.signal });
      if (generation !== access) throw new Error("Acceso cerrado.");
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401) logout();
        throw new Error(notices[payload.reason] || "No fue posible completar la consulta.");
      }
      return response;
    } finally { clearTimeout(timer); pending.delete(controller); }
  };
  const action = async (button, work) => {
    const generation = access; button.disabled = true; notify();
    try { await work(); }
    catch (error) { if (generation === access || !token) notify(error.name === "AbortError" ? "La consulta tardó demasiado. Inténtalo de nuevo." : error.message, true); }
    finally { button.disabled = button.id === "next" ? !cursor : button.id === "previous" ? page === 0 : false; }
  };
  const element = (tag, text, className = "") => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const load = async current => {
    const query = new URLSearchParams(filters); if (current) query.set("cursor", current);
    const generation = access, requestId = ++listRequest, data = await (await request("?" + query)).json();
    if (generation !== access || requestId !== listRequest) return;
    cursor = data.nextCursor; $("records").replaceChildren();
    $("count").textContent = `${data.items.length} en esta página`; $("empty").hidden = data.items.length > 0;
    $("page-label").textContent = `Página ${page + 1}`; $("previous").disabled = page === 0; $("next").disabled = !cursor;
    for (const chat of data.items) {
      const li = element("li", ""), button = element("button", "", "record"); button.type = "button";
      button.dataset.id = chat.chat_id; button.setAttribute("aria-pressed", String(chat.chat_id === selected));
      button.append(element("strong", chat.redacted_at ? "Datos suprimidos" : chat.citizen_name || "Sin nombre"),
        element("span", chat.citizen_email || "Sin correo registrado", "email-line"));
      const row = element("span", "", "row"); row.append(element("span", dateText(chat.started_at)), element("span", `${chat.message_count} mensajes`));
      if (chat.used_rpa) row.append(element("span", "Trámite iniciado", "tag")); button.append(row);
      button.addEventListener("click", () => action(button, () => show(chat.chat_id))); li.append(button); $("records").append(li);
    }
  };
  const show = async id => {
    selected = id; const generation = access;
    $("detail").hidden = $("json").hidden = true; $("detail-empty").hidden = false; $("detail-empty").textContent = "Cargando conversación…";
    try {
      const chat = await (await request("/" + encodeURIComponent(id))).json();
      if (selected !== id || generation !== access) return;
      document.querySelectorAll(".record").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.id === id)));
      $("metadata").replaceChildren();
      for (const [label, value] of [["Ciudadano", chat.redacted_at ? "Datos suprimidos" : chat.citizen_name || "Sin nombre"],
        ["Correo", chat.citizen_email || "—"], ["Inicio", dateText(chat.started_at)], ["Último mensaje", dateText(chat.last_message_at)],
        ["Cierre", dateText(chat.ended_at)], ["Trámites", chat.rpa_flows.join(", ") || "Ninguno"], ["ID del chat", chat.chat_id]]) {
        $("metadata").append(element("dt", label), element("dd", value));
      }
      $("messages").replaceChildren();
      for (const message of chat.messages) {
        const li = element("li", "", "message " + (message.sender === "user" ? "user" : "bot"));
        const sender = message.sender === "user" ? "Ciudadano" : message.sender === "bot" ? "florIA" : "Sistema";
        li.append(element("div", `${sender} · ${dateText(message.at)}`, "message-label"), element("p", message.text)); $("messages").append(li);
      }
      if (!chat.messages.length) $("messages").append(element("li", chat.redacted_at ? "El contenido de este chat fue suprimido." : "Todavía no hay mensajes guardados.", "empty"));
      $("detail-empty").hidden = true; $("detail").hidden = $("json").hidden = false;
    } catch (error) { if (selected === id) $("detail-empty").textContent = "No fue posible cargar el chat."; throw error; }
  };
  const download = async (path, name) => {
    const generation = access, response = await request(path), blob = await response.blob();
    if (generation !== access) return;
    const url = URL.createObjectURL(blob), link = element("a", ""); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    const count = response.headers.get("X-Exported-Count"); notify(count ? `Resumen descargado: ${count} conversaciones.` : "Chat completo descargado.");
  };
  $("login-form").addEventListener("submit", event => { event.preventDefault(); action($("enter"), async () => {
    token = $("token").value; access++; filters = ""; pages = [null]; page = 0;
    await load(null); $("token").value = ""; $("filters").reset(); $("login").hidden = true; $("workspace").hidden = $("logout").hidden = false;
  }); });
  $("logout").addEventListener("click", () => { logout(); notify(); });
  $("filters").addEventListener("submit", event => { event.preventDefault(); action($("apply"), async () => {
    const query = new URLSearchParams(); for (const [key, value] of new FormData(event.target)) if (value) query.set(key, value);
    filters = query.toString(); pages = [null]; page = 0; selected = null;
    $("detail").hidden = $("json").hidden = true; $("detail-empty").hidden = false;
    $("detail-empty").textContent = "Selecciona un chat para leer sus mensajes."; await load(null);
  }); });
  $("clear").addEventListener("click", () => { $("filters").reset(); $("filters").requestSubmit(); });
  $("next").addEventListener("click", () => action($("next"), async () => { if (!cursor) return; const next = cursor; await load(next); page++; pages[page] = next; $("page-label").textContent = `Página ${page + 1}`; $("previous").disabled = false; }));
  $("previous").addEventListener("click", () => action($("previous"), async () => { if (!page) return; await load(pages[page - 1]); page--; $("page-label").textContent = `Página ${page + 1}`; $("previous").disabled = page === 0; }));
  $("csv").addEventListener("click", () => action($("csv"), () => download("/export.csv?" + filters, "floria-conversaciones.csv")));
  $("json").addEventListener("click", () => action($("json"), () => download("/" + encodeURIComponent(selected) + "/export.json", `floria-chat-${selected}.json`)));
})();
