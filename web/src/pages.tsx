import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api.js';
import type {
  AuditRecord, GuildChoice, GuildResources, GuildSettings, ModerationCase, Report, ReportEvent,
  ScheduledAnnouncement, StoredSettings, Ticket, TicketMessage, TicketParticipant, TicketPanel, TicketPanelInput, TicketPanelType, Warning,
} from './types.js';

type PageKey = 'overview' | 'tickets' | 'reports' | 'moderation' | 'security' | 'announcements' | 'resources' | 'activity' | 'settings';
type Notify = (kind: 'success' | 'error', text: string) => void;
interface Props { page: PageKey; guild: GuildChoice; guilds: GuildChoice[]; onSelectGuild: (guild: GuildChoice) => void; onNotify: Notify; onChanged: (text?: string) => void; reloadSequence: number; onNavigate: (page: PageKey) => void; }

export function DashboardPage(props: Props) {
  switch (props.page) {
    case 'overview': return <OverviewPage {...props} />;
    case 'tickets': return <TicketsPage {...props} />;
    case 'reports': return <ReportsPage {...props} />;
    case 'moderation': return <ModerationPage {...props} />;
    case 'security': return <SecurityPage {...props} />;
    case 'announcements': return <AnnouncementsPage {...props} />;
    case 'resources': return <ResourcesPage {...props} />;
    case 'activity': return <ActivityPage {...props} />;
    case 'settings': return <SettingsPage {...props} />;
  }
}

function useRemote<T>(path: string, reload: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState('');
  const [localReload, setLocalReload] = useState(0);
  useEffect(() => {
    let active = true;
    if (!path) { setData(null); setLoading(false); setError(''); return () => { active = false; }; }
    setData(null); setLoading(true); setError('');
    void api.request<T>(path).then((result) => { if (active) setData(result); })
      .catch((reason: unknown) => { if (active) setError(errorText(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, reload, localReload]);
  return { data, loading, error, refresh: () => setLocalReload((n) => n + 1) };
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return error.message || 'Non hai il ruolo Discord necessario per questi dati.';
    if (error.status === 404) return error.message || 'La risorsa richiesta non esiste.';
    if (error.status === 409) return error.message || 'I dati sono cambiati. Ricarica e riprova.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Richiesta non riuscita.';
}

function useMutation(onNotify: Notify, onChanged: (text?: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try { await job(); onChanged(success); return true; }
    catch (error) { onNotify('error', errorText(error)); return false; }
    finally { setBusy(false); }
  };
  return { busy, run };
}

function apiBase(guildId: string) { return `/guilds/${guildId}`; }
function date(value: string | null | undefined) { return value ? new Date(value).toLocaleString('it-IT') : '—'; }
function shortId(value: string | null | undefined) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—'; }
function json(value: unknown) { return JSON.stringify(value, null, 2); }
function ticketStatusLabel(status: Ticket['status']) {
  return ({ creating: 'In creazione', open: 'Aperto', closing: 'Chiusura in corso', closed: 'Chiuso', failed: 'Non riuscito' } as const)[status];
}
function reportStatusLabel(status: Report['status']) {
  return ({ new: 'Nuova', assigned: 'Assegnata', info_requested: 'Informazioni richieste', accepted: 'Accettata', rejected: 'Respinta' } as const)[status];
}
function announcementStatusLabel(status: string) {
  return ({ pending: 'Programmato', running: 'In corso', completed: 'Completato', cancelled: 'Annullato', failed: 'Non riuscito' } as Record<string, string>)[status] ?? 'Stato non disponibile';
}
function operationStatusLabel(status: string) {
  return ({ pending: 'In attesa', in_progress: 'Creazione in corso', completed: 'Completata', recovery_needed: 'Riparazione necessaria', failed: 'Errore' } as Record<string, string>)[status] ?? 'Stato non disponibile';
}
function operationResourceLabel(key: string) {
  return ({ panelId: 'pannello', panelCategoryId: 'categoria pannello', ticketCategoryId: 'categoria ticket', channelId: 'canale', messageId: 'messaggio', ticketId: 'ticket' } as Record<string, string>)[key] ?? 'risorsa';
}
function reportEventLabel(event: string) {
  return ({ created: 'Segnalazione creata', assigned: 'Assegnata', info_requested: 'Informazioni richieste', accepted: 'Accettata', rejected: 'Respinta', notification_failed: 'Notifica allo staff non riuscita', dm_failed: 'Messaggio privato non consegnato' } as Record<string, string>)[event] ?? 'Aggiornamento segnalazione';
}
function auditActionLabel(action: string) {
  return ({
    'settings.update': 'Impostazioni aggiornate', 'ticket.open': 'Ticket aperto', 'ticket.recover': 'Ticket ripristinato',
    'ticket.assign': 'Ticket preso in carico', 'ticket.close': 'Ticket chiuso', 'ticket.reply': 'Risposta inviata nel ticket',
    'ticket.staff-access.reconcile': 'Accessi staff ticket riallineati', 'ticket.panel.staff-access.reconcile': 'Accessi del pannello riallineati',
    'ticket.panel.create': 'Pannello ticket creato', 'ticket.panel.update': 'Pannello ticket aggiornato',
    'ticket.panel.repair': 'Pannello ticket riparato', 'ticket.panel.delete': 'Pannello ticket eliminato',
    'ticket.panel.enable': 'Aperture ticket riattivate', 'ticket.panel.disable': 'Nuove aperture ticket disattivate',
    'retention.cleanup': 'Pulizia dei dati completata', 'report.create': 'Segnalazione ricevuta',
    'security.detect': 'Evento di sicurezza rilevato', 'security.join.detect': 'Controllo nuovo membro completato',
    'security.lockdown.activate': 'Blocco del server attivato', 'security.lockdown.restore': 'Permessi del server ripristinati',
    'security.channel.lock': 'Canale bloccato', 'security.channel.unlock': 'Canale sbloccato',
    'security.automations.stop': 'Automazioni sospese', 'security.automations.start': 'Automazioni riattivate',
    'announcement.schedule': 'Annuncio programmato', 'announcement.send': 'Annuncio pubblicato',
    'announcement.update': 'Annuncio aggiornato', 'announcement.cancel': 'Annuncio annullato',
    'moderation.warning': 'Avvertimento registrato', 'moderation.warning.revoke': 'Avvertimento revocato',
    'moderation.timeout': 'Timeout applicato', 'moderation.untimeout': 'Timeout rimosso', 'moderation.kick': 'Utente espulso',
    'moderation.unban': 'Ban rimosso', 'moderation.slowmode': 'Modalità lenta aggiornata',
    'moderation.ban': 'Utente bannato', 'moderation.purge': 'Messaggi rimossi', 'moderation.warning.escalation': 'Escalation di moderazione applicata',
  } as Record<string, string>)[action] ?? (action.startsWith('scheduled.') ? 'Attività programmata eseguita' : 'Operazione registrata');
}
function auditTargetLabel(target: string) {
  return ({ 'guild-settings': 'impostazioni server', 'ticket': 'ticket', 'ticket-panel': 'pannello ticket', 'ticket-operation': 'operazione ticket', 'report': 'segnalazione', 'scheduled-task': 'attività programmata', 'channel': 'canale', 'user': 'utente', 'warning': 'avvertimento', 'guild': 'server', 'moderation-case': 'caso di moderazione' } as Record<string, string>)[target] ?? 'risorsa';
}
function auditResultLabel(result: string) {
  return ({ ok: 'Completato', failed: 'Non riuscito', uncertain: 'Da verificare' } as Record<string, string>)[result] ?? 'Esito non disponibile';
}
function moderationActionLabel(action: string) {
  return ({ warning: 'Avvertimento', timeout: 'Timeout', untimeout: 'Rimozione timeout', kick: 'Espulsione', ban: 'Ban', unban: 'Rimozione ban', slowmode: 'Modalità lenta', purge: 'Pulizia messaggi', 'channel-lock': 'Blocco canale', 'security-warning-escalation': 'Escalation di sicurezza' } as Record<string, string>)[action] ?? 'Azione di moderazione';
}
function moderationResultLabel(result: string) {
  if (result === 'ok') return 'Completato';
  if (result === 'failed') return 'Non riuscito';
  if (result.startsWith('failed:')) return `Non riuscito · ${result.slice('failed:'.length).trim()}`;
  if (result.includes('messaggio privato non consegnato')) return 'Completato · messaggio privato non consegnato';
  return 'Da verificare';
}

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return <div className="page-heading"><div><h2>{title}</h2><p>{description}</p></div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}
function Panel({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return <section className="card"><div className="card-header"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>{actions}</div>{children}</section>;
}
function RemoteState({ loading, error, onRetry }: { loading: boolean; error: string; onRetry: () => void }) {
  if (loading) return <div className="loading"><span className="spinner" /></div>;
  if (error) return <div className="notice"><span>{error}</span><button className="button ghost small" onClick={onRetry}>Riprova</button></div>;
  return null;
}
function Empty({ title, children }: { title: string; children?: React.ReactNode }) { return <div className="empty"><div><strong>{title}</strong>{children}</div></div>; }
function FormField({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) {
  return <div className="field"><label>{label}</label>{children}{help && <p className="help">{help}</p>}</div>;
}
function Kpi({ label, value, foot, icon }: { label: string; value: React.ReactNode; foot?: string; icon: string }) {
  return <div className="card"><div className="card-header"><span className="kpi-label">{label}</span><span className="kpi-icon">{icon}</span></div><div className="kpi-value">{value}</div>{foot && <div className="kpi-foot">{foot}</div>}</div>;
}
function Select({ value, onChange, children, label, disabled }: { value: string; onChange: (value: string) => void; children: React.ReactNode; label: string; disabled?: boolean }) {
  return <select className="select" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{children}</select>;
}

function OverviewPage({ guild, reloadSequence, onNavigate }: Props) {
  const base = apiBase(guild.id);
  const diagnostics = useRemote<{ botReady: boolean; guildAvailable: boolean; modules: GuildSettings['modules']; channels: Array<{ purpose: string; configured: boolean; available: boolean }>; automationStopped: boolean }>(`${base}/diagnostics`, reloadSequence);
  const tickets = useRemote<{ tickets: Ticket[] }>(`${base}/tickets?limit=100&offset=0`, reloadSequence);
  const reports = useRemote<{ reports: Report[] }>(`${base}/reports?limit=100&offset=0`, reloadSequence);
  const audit = useRemote<{ records: AuditRecord[] }>(`${base}/audit-log`, reloadSequence);
  const openTickets = tickets.data?.tickets.filter((ticket) => ticket.status === 'open').length;
  const pendingReports = reports.data?.reports.filter((report) => report.status === 'new' || report.status === 'assigned').length;
  const failedChannels = diagnostics.data?.channels.filter((channel) => channel.configured && !channel.available).length ?? 0;
  return <>
    <PageHeader title={`Ciao, ${guild.name}`} description="Stato del bot, code e controlli del server aggiornati dalle API." actions={<span className={`status-pill ${diagnostics.data?.botReady ? 'status-ok' : 'status-warn'}`}>{diagnostics.data?.botReady ? 'Bot connesso' : 'Bot non disponibile'}</span>} />
    <RemoteState loading={diagnostics.loading} error={diagnostics.error} onRetry={diagnostics.refresh} />
    <div className="grid kpis">
      <Kpi label="Ticket aperti" value={tickets.loading ? '…' : tickets.error ? '—' : openTickets ?? 0} foot={tickets.error || 'Coda visibile al tuo ruolo'} icon="▤" />
      <Kpi label="Segnalazioni da esaminare" value={reports.loading ? '…' : reports.error ? '—' : pendingReports ?? 0} foot={reports.error || 'Segnalazioni non riservate accessibili'} icon="⚑" />
      <Kpi label="Moduli attivi" value={diagnostics.data ? Object.values(diagnostics.data.modules).filter(Boolean).length : '—'} foot="Configurazione salvata nel server" icon="◈" />
      <Kpi label="Canali da verificare" value={diagnostics.data ? failedChannels : '—'} foot={diagnostics.data?.automationStopped ? 'Automazioni sospese' : 'Diagnostica backend'} icon="⌁" />
    </div>
    <div className="grid two">
      <Panel title="Diagnostica" subtitle="Stato restituito dal bot e dai canali configurati.">
        <RemoteState loading={diagnostics.loading} error={diagnostics.error} onRetry={diagnostics.refresh} />
        {diagnostics.data && <div className="detail-list">
          <Detail label="Server Discord" value={diagnostics.data.guildAvailable ? 'Disponibile' : 'Non raggiungibile'} />
          <Detail label="Automazioni" value={diagnostics.data.automationStopped ? 'Sospese manualmente' : 'Attive'} />
          {diagnostics.data.channels.map((channel) => <Detail key={channel.purpose} label={channel.purpose} value={!channel.configured ? 'Non configurato' : channel.available ? 'Disponibile' : 'Canale non trovato'} />)}
        </div>}
      </Panel>
      <Panel title="Accesso rapido" subtitle="Apri una sezione. L’API applica i ruoli configurati.">
        <div className="button-row">
          <button className="button" onClick={() => onNavigate('tickets')}>Apri ticket</button>
          <button className="button" onClick={() => onNavigate('reports')}>Esamina segnalazioni</button>
          <button className="button" onClick={() => onNavigate('security')}>Controlli sicurezza</button>
          <button className="button" onClick={() => onNavigate('settings')}>Impostazioni</button>
        </div>
        <p className="help">I dati non accessibili per il tuo ruolo restano nascosti e vengono mostrati come errore di autorizzazione.</p>
      </Panel>
      <Panel title="Ultime operazioni" subtitle="Registro audit reale del backend." actions={<button className="button ghost small" onClick={() => onNavigate('activity')}>Apri registro</button>}>
        <RemoteState loading={audit.loading} error={audit.error} onRetry={audit.refresh} />
        {!audit.loading && !audit.error && !audit.data?.records.length && <Empty title="Nessuna operazione registrata" />}
        {audit.data?.records.slice(0, 5).map((record) => <ActivityItem key={record.id} record={record} />)}
      </Panel>
      <Panel title="Stato delle code" subtitle="Solo elementi restituiti dalle API autorizzate.">
        <RemoteState loading={tickets.loading || reports.loading} error={tickets.error || reports.error} onRetry={() => { tickets.refresh(); reports.refresh(); }} />
        <div className="detail-list"><Detail label="Ticket" value={tickets.error ? 'Non accessibile' : `${tickets.data?.tickets.length ?? 0} caricati`} /><Detail label="Segnalazioni" value={reports.error ? 'Non accessibili' : `${reports.data?.reports.length ?? 0} caricate`} /></div>
      </Panel>
    </div>
  </>;
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) { return <div className="detail-row"><span>{label}</span><span>{value}</span></div>; }
function ActivityItem({ record }: { record: AuditRecord }) {
  return <div className="activity-item"><span className="activity-dot" /><div><div className="activity-title">{auditActionLabel(record.action)} · {auditResultLabel(record.result)}</div><div className="activity-detail">{auditTargetLabel(record.targetType)} {record.targetId ?? ''} · operatore {shortId(record.actorId)}</div></div><time className="activity-time">{date(record.createdAt)}</time></div>;
}

function TicketsPage({ guild, guilds, onSelectGuild, reloadSequence, onNotify, onChanged }: Props) {
  const base = apiBase(guild.id);
  const [status, setStatus] = useState('open'); const [search, setSearch] = useState(''); const [selectedId, setSelectedId] = useState(''); const [offset, setOffset] = useState(0);
  const [panelFilter, setPanelFilter] = useState('');
  const [messageBefore, setMessageBefore] = useState(''); const [allMessages, setAllMessages] = useState<TicketMessage[]>([]);
  const [reply, setReply] = useState(''); const [participantId, setParticipantId] = useState(''); const [closeReason, setCloseReason] = useState('');
  const query = new URLSearchParams(); if (status) query.set('status', status); if (panelFilter) query.set('panelId', panelFilter); if (search.trim()) query.set('search', search.trim()); query.set('limit', '50'); query.set('offset', String(offset));
  const list = useRemote<{ tickets: Ticket[] }>(`${base}/tickets?${query}`, reloadSequence);
  const detail = useRemote<{ ticket: Ticket; participants: TicketParticipant[] }>(selectedId ? `${base}/tickets/${selectedId}` : '', reloadSequence);
  const messageQuery = new URLSearchParams({ limit: '50' }); if (messageBefore) messageQuery.set('before', messageBefore);
  const messages = useRemote<{ messages: TicketMessage[] }>(selectedId ? `${base}/tickets/${selectedId}/messages?${messageQuery}` : '', reloadSequence);
  useEffect(() => { setAllMessages([]); setMessageBefore(''); }, [selectedId]);
  useEffect(() => {
    if (!messages.data) return;
    setAllMessages((current) => {
      if (!messageBefore) return messages.data!.messages;
      const known = new Set(current.map((message) => message.id));
      return [...messages.data!.messages.filter((message) => !known.has(message.id)), ...current];
    });
  }, [messages.data, messageBefore]);
  const mutation = useMutation(onNotify, onChanged);
  const sendReply = async () => {
    if (!selectedId || !reply.trim()) return;
    const ok = await mutation.run(() => api.request(`${base}/tickets/${selectedId}/messages`, { method: 'POST', body: { content: reply.trim() } }), 'Risposta inviata nel canale Discord del ticket.');
    if (ok) { setReply(''); setMessageBefore(''); messages.refresh(); }
  };
  const changeParticipant = async (userId: string, action: 'add' | 'remove') => {
    if (!selectedId) return;
    const ok = await mutation.run(() => api.request(`${base}/tickets/${selectedId}/participants`, { method: 'POST', body: { userId, action } }), action === 'add' ? 'Partecipante aggiunto al ticket.' : 'Partecipante rimosso dal ticket.');
    if (ok) { setParticipantId(''); detail.refresh(); }
  };
  const assign = () => selectedId && void mutation.run(() => api.request(`${base}/tickets/${selectedId}/assign`, { method: 'POST', body: {} }), 'Ticket assegnato al tuo account Discord.');
  const close = async () => {
    if (!selectedId || closeReason.trim().length < 3) { onNotify('error', 'Inserisci un motivo di almeno 3 caratteri.'); return; }
    if (!window.confirm('Confermi la chiusura e l’archiviazione del ticket Discord?')) return;
    const ok = await mutation.run(() => api.request(`${base}/tickets/${selectedId}/close`, { method: 'POST', body: { reason: closeReason.trim() } }), 'Ticket archiviato.');
    if (ok) { setCloseReason(''); detail.refresh(); list.refresh(); }
  };
  const downloadTranscript = async () => {
    if (!selectedId) return;
    try {
      const blob = await api.download(`${base}/tickets/${selectedId}/transcript/download`); const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `ticket-${selectedId}-trascrizione.txt`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      onNotify('success', 'Trascrizione autorizzata scaricata.');
    } catch (error) { onNotify('error', errorText(error)); }
  };
  return <>
    <PageHeader title="Coda ticket" description="Leggi i messaggi dal canale privato, rispondi come staff e gestisci i partecipanti." />
    <TicketPanelManager guild={guild} guilds={guilds} onSelectGuild={onSelectGuild} onViewTickets={(panelId) => { setPanelFilter(panelId); setStatus(''); setOffset(0); }} reloadSequence={reloadSequence} onNotify={onNotify} onChanged={onChanged} />
    <div className="split">
      <Panel title="Ticket" subtitle={panelFilter ? `Ticket collegati al pannello ${shortId(panelFilter)}.` : 'La visibilità dipende dal ruolo ticket staff o dall’accesso al ticket.'} actions={panelFilter ? <button className="button ghost small" onClick={() => setPanelFilter('')}>Mostra tutti</button> : undefined}>
        <div className="toolbar"><Select label="Stato ticket" value={status} onChange={(value) => { setStatus(value); setOffset(0); }}><option value="">Tutti gli stati</option><option value="open">Aperti</option><option value="closed">Chiusi</option><option value="creating">In creazione</option><option value="failed">Non riusciti</option></Select><input className="input search" placeholder="Cerca ID, utente o categoria" value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} /></div>
        <RemoteState loading={list.loading} error={list.error} onRetry={list.refresh} />
        {!list.loading && !list.error && !list.data?.tickets.length && <Empty title="Nessun ticket corrispondente" />}
        {!!list.data?.tickets.length && <><div className="table-wrap"><table><thead><tr><th>Ticket</th><th>Categoria</th><th>Stato</th><th>Aperto</th><th></th></tr></thead><tbody>{list.data.tickets.map((ticket) => <tr key={ticket.id} className={ticket.id === selectedId ? 'selected-row' : ''}><td className="mono">{shortId(ticket.id)}<br /><span className="muted">{shortId(ticket.openerId)}</span></td><td>{ticket.categoryKey}</td><td>{ticketStatusLabel(ticket.status)}</td><td className="nowrap">{date(ticket.openedAt)}</td><td><button className="table-action" onClick={() => setSelectedId(ticket.id)}>Apri</button></td></tr>)}</tbody></table></div><div className="pagination"><span>{offset + 1}–{offset + list.data.tickets.length}</span><div className="button-row"><button className="button small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Precedenti</button><button className="button small" disabled={list.data.tickets.length < 50} onClick={() => setOffset(offset + 50)}>Successivi</button></div></div></>}
      </Panel>
      <div className="grid">
        {!selectedId ? <Panel title="Dettaglio ticket" subtitle="Seleziona un ticket dalla coda."><Empty title="Nessun ticket selezionato" /></Panel> : <>
          <Panel title="Conversazione" subtitle={detail.data ? `${detail.data.ticket.categoryKey} · utente ${shortId(detail.data.ticket.openerId)} · ${ticketStatusLabel(detail.data.ticket.status)}` : 'Caricamento dettagli'} actions={<button className="button small" onClick={() => void downloadTranscript()}>Scarica trascrizione</button>}>
            <RemoteState loading={detail.loading || messages.loading} error={detail.error || messages.error} onRetry={() => { detail.refresh(); messages.refresh(); }} />
            {messages.data?.messages.length === 50 && <div className="form-actions"><button className="button small" disabled={messages.loading} onClick={() => setMessageBefore(messages.data?.messages[0]?.id ?? '')}>Carica messaggi precedenti</button></div>}
            <div className="message-list">{allMessages.map((message) => <div key={message.id} className={`chat-message ${message.bot ? 'staff' : ''}`}><div className="chat-head"><span className="chat-author">{message.authorName} {message.bot ? '· bot/staff' : ''}</span><time className="chat-time">{date(message.createdAt)}</time></div><p className="chat-content">{message.content || '(messaggio senza testo)'}</p>{!!message.attachments.length && <div className="chat-files">Allegati: {message.attachments.join(', ')}</div>}</div>)}</div>
            {!messages.loading && !messages.error && !allMessages.length && <Empty title="Nessun messaggio disponibile" />}
            <div className="field mt-14"><label htmlFor="ticket-reply">Risposta dello staff</label><textarea id="ticket-reply" className="textarea" maxLength={2000} placeholder="Scrivi una risposta pubblicata nel canale ticket dal bot…" value={reply} onChange={(event) => setReply(event.target.value)} /></div>
            <div className="form-actions"><button className="button primary" disabled={mutation.busy || !reply.trim() || detail.data?.ticket.status !== 'open'} onClick={() => void sendReply()}>{mutation.busy ? 'Invio…' : 'Invia risposta'}</button></div>
          </Panel>
          <Panel title="Gestione ticket" subtitle="Ogni azione viene verificata dal backend e registrata.">
            <div className="button-row"><button className="button" disabled={mutation.busy} onClick={assign}>Assegna a me</button><span className="status-pill status-neutral">Assegnato: {shortId(detail.data?.ticket.assignedTo)}</span></div>
            <div className="detail-list mt-15"><Detail label="Partecipanti aggiunti" value={detail.data?.participants.length ? detail.data.participants.map((item) => shortId(item.userId)).join(', ') : 'Nessuno'} />
              {detail.data?.participants.map((item) => <div className="button-row" key={item.userId}><span className="mono">{item.userId}</span><button className="button ghost small" onClick={() => void changeParticipant(item.userId, 'remove')}>Rimuovi</button></div>)}
            </div>
            <div className="inline-form mt-14"><FormField label="Aggiungi partecipante tramite ID Discord"><input className="input" inputMode="numeric" value={participantId} onChange={(event) => setParticipantId(event.target.value)} placeholder="ID utente Discord" /></FormField><button className="button" disabled={mutation.busy || !/^\d{17,20}$/.test(participantId)} onClick={() => void changeParticipant(participantId, 'add')}>Aggiungi</button></div>
            <div className="inline-form mt-14"><FormField label="Motivo chiusura"><input className="input" maxLength={500} value={closeReason} onChange={(event) => setCloseReason(event.target.value)} placeholder="Motivo registrato nella trascrizione" /></FormField><button className="button danger" disabled={mutation.busy || detail.data?.ticket.status !== 'open'} onClick={() => void close()}>Chiudi ticket</button></div>
          </Panel>
        </>}
      </div>
    </div>
  </>;
}

function TicketPanelManager({ guild, guilds, onSelectGuild, onViewTickets, reloadSequence, onNotify, onChanged }: Pick<Props, 'guild' | 'guilds' | 'onSelectGuild' | 'reloadSequence' | 'onNotify' | 'onChanged'> & { onViewTickets: (panelId: string) => void }) {
  const base = apiBase(guild.id);
  const panels = useRemote<{ panels: TicketPanel[] }>(`${base}/tickets/panels`, reloadSequence);
  const [wizard, setWizard] = useState<TicketPanel | 'new' | null>(null);
  const [wizardGuild, setWizardGuild] = useState(guild);
  const resources = useRemote<GuildResources>(wizard ? `${apiBase(wizardGuild.id)}/resources` : '', reloadSequence);
  const mutation = useMutation(onNotify, onChanged);
  const refresh = () => panels.refresh();
  const toggle = (panel: TicketPanel) => void mutation.run(
    () => api.request(`${base}/tickets/panels/${panel.id}/status`, { method: 'POST', body: { enabled: !panel.enabled } }),
    panel.enabled ? 'Nuove aperture disattivate; i ticket esistenti restano disponibili.' : 'Il pannello ticket è attivo.',
  ).then((ok) => { if (ok) refresh(); });
  const repair = (panel: TicketPanel) => void mutation.run(
    () => api.request(`${base}/tickets/panels/${panel.id}/repair`, { method: 'POST', body: {} }),
    'Verifica e riparazione completate.',
  ).then((ok) => { if (ok) refresh(); });
  const remove = async (panel: TicketPanel) => {
    const description = `Verrà rimosso il messaggio ${panel.messageId} dal canale ${panel.channelId}. Resteranno: canale ${panel.channelId}, categoria pannello ${panel.panelCategoryId ?? 'nessuna'}, categoria ticket ${panel.ticketCategoryId} e ${panel.ticketCount ?? 0} ticket.`;
    if (!window.confirm(`Eliminare il pannello “${panel.name}”?\n\n${description}`)) return;
    const ok = await mutation.run(() => api.request(`${base}/tickets/panels/${panel.id}`, { method: 'DELETE', body: { confirmResourceIds: [panel.messageId] } }), 'Messaggio pannello rimosso; canali e ticket conservati.');
    if (ok) refresh();
  };
  const openCreate = () => { setWizardGuild(guild); setWizard('new'); };
  return <>
    <Panel title="Pannelli ticket" subtitle="Ogni pannello ha categorie, ruoli, moduli e limiti indipendenti." actions={<button className="button primary" onClick={openCreate}>Crea pannello ticket</button>}>
      <RemoteState loading={panels.loading} error={panels.error} onRetry={panels.refresh} />
      {!panels.loading && !panels.error && !panels.data?.panels.length && <Empty title="Nessun pannello gestito" >Crea un pannello per pubblicare le tipologie ticket in un canale Discord.</Empty>}
      {!!panels.data?.panels.length && <div className="detail-list">{panels.data.panels.map((panel) => <div className="ticket-panel-row" key={panel.id}>
        <div className="ticket-panel-main">
          <strong>{panel.name}</strong>
          <span className={`status-pill ${panel.status === 'active' ? 'status-ok' : panel.status === 'disabled' ? 'status-neutral' : 'status-warn'}`}>{panel.status === 'active' ? 'Pannello attivo' : panel.status === 'disabled' ? 'Aperture disattivate' : 'Riparazione necessaria'}</span>
          <a href={`https://discord.com/channels/${guild.id}/${panel.channelId}`} target="_blank" rel="noopener noreferrer">Apri il canale Discord ↗</a>
          <span className="help">Ticket collegati: {panel.ticketCount ?? 0} · messaggio {shortId(panel.messageId)} · {panel.health?.missing.length ? `risorse mancanti: ${panel.health.missing.join(', ')}` : 'risorse verificate'}</span>
        </div>
        <div className="button-row">
          <button className="button small" disabled={mutation.busy} onClick={() => toggle(panel)}>{panel.enabled ? 'Disattiva aperture' : 'Riattiva'}</button>
          <button className="button small" onClick={() => onViewTickets(panel.id)}>Vedi ticket</button>
          <button className="button small" disabled={mutation.busy} onClick={() => repair(panel)}>Verifica / ripara</button>
          <button className="button small" disabled={mutation.busy} onClick={() => { setWizardGuild(guild); setWizard(panel); }}>Modifica</button>
          <button className="button ghost small" disabled={mutation.busy} onClick={() => void remove(panel)}>Elimina pannello</button>
        </div>
      </div>)}</div>}
    </Panel>
    {wizard && <TicketPanelWizard guild={wizardGuild} guilds={guilds.filter((item) => item.botStatus === 'presente')} onGuildChange={setWizardGuild}
      resources={resources} panel={wizard === 'new' ? null : wizard}
      onClose={() => setWizard(null)} onNotify={onNotify} onSaved={(message) => { const target = wizardGuild; setWizard(null); if (target.id !== guild.id) onSelectGuild(target); onChanged(message); refresh(); }} />}
  </>;
}

function newOperationUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ticketResourceLabel(choice: TicketPanelInput['panelCategory'], resources: GuildResources['channels'], prefix = ''): string {
  if (choice.mode === 'create') return `${prefix}${choice.name}`;
  return resources.find((item) => item.id === choice.id)?.name ?? choice.id;
}

function emptyPanelConfig(): TicketPanelInput {
  return {
    name: 'Assistenza community', panelTitle: 'Apri un ticket', description: 'Scegli una tipologia e descrivi la richiesta. Lo staff ti risponderà in un canale privato.',
    color: '#5865f2', footer: 'The Last Pact Guardian', layout: 'menu',
    panelCategory: { mode: 'create', name: 'supporto' }, panelChannel: { mode: 'create', name: 'apri-ticket' },
    ticketCategory: { mode: 'create', name: 'ticket-privati' }, staffRoleIds: [], maxOpenPerUser: 1,
    maxConcurrentTotal: 100, cooldownSeconds: 60,
    categories: [{ key: 'assistenza', label: 'Assistenza', buttonLabel: 'Assistenza', description: 'Richiedi aiuto allo staff', staffRoleIds: [], fields: [{ key: 'descrizione', label: 'Descrivi la richiesta', style: 'paragraph', required: true }] }],
  };
}

function TicketPanelWizard({ guild, guilds, onGuildChange, resources, panel, onClose, onNotify, onSaved }: {
  guild: GuildChoice; guilds: GuildChoice[]; onGuildChange: (guild: GuildChoice) => void; resources: ReturnType<typeof useRemote<GuildResources>>; panel: TicketPanel | null;
  onClose: () => void; onNotify: Notify; onSaved: (message: string) => void;
}) {
  const base = apiBase(guild.id);
  const [draft, setDraft] = useState<TicketPanelInput>(() => panel ? panel.config : emptyPanelConfig());
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [operationKey, setOperationKey] = useState(newOperationUuid);
  const [operation, setOperation] = useState<{ operationId: string; status: string; resources: Record<string, string | boolean>; error?: string } | null>(null);
  const [error, setError] = useState('');
  const update = (next: TicketPanelInput) => { setDraft(next); setOperationKey(newOperationUuid()); setOperation(null); setError(''); };
  const channelChoices = resources.data?.channels ?? [];
  const roleChoices = resources.data?.roles ?? [];
  const categoryChoices = channelChoices.filter((channel) => channel.type === 4);
  const textChoices = channelChoices.filter((channel) => channel.type === 0);
  const steps = ['Canali', 'Tipologie e ruoli', 'Aspetto', 'Limiti', 'Anteprima'];
  const updateCategory = (index: number, patch: Partial<TicketPanelType>) => {
    const categories = [...draft.categories];
    const current = categories[index];
    if (!current) return;
    categories[index] = { ...current, ...patch };
    update({ ...draft, categories });
  };
  const updateField = (categoryIndex: number, fieldIndex: number, patch: Partial<TicketPanelType['fields'][number]>) => {
    const categories = [...draft.categories];
    const category = categories[categoryIndex];
    const field = category?.fields[fieldIndex];
    if (!category || !field) return;
    const fields = [...category.fields]; fields[fieldIndex] = { ...field, ...patch };
    categories[categoryIndex] = { ...category, fields };
    update({ ...draft, categories });
  };
  const choiceEditor = (key: 'panelCategory' | 'panelChannel' | 'ticketCategory', label: string) => {
    const current = draft[key];
    const choices = key === 'panelChannel' ? textChoices : key === 'ticketCategory' ? categoryChoices.filter((item) => !item.publicView) : categoryChoices;
    const canChangeResource = !panel;
    return <div className="field"><label>{label}</label>
      <div className="button-row"><button type="button" className={`button small ${current.mode === 'create' ? 'primary' : ''}`} disabled={!canChangeResource} onClick={() => update({ ...draft, [key]: { mode: 'create', name: key === 'panelChannel' ? 'apri-ticket' : key === 'panelCategory' ? 'supporto' : 'ticket-privati' } })}>Crea nuovo</button>
        <button type="button" className={`button small ${current.mode === 'existing' ? 'primary' : ''}`} disabled={!canChangeResource} onClick={() => update({ ...draft, [key]: { mode: 'existing', id: choices[0]?.id ?? '' } })}>Seleziona esistente</button></div>
      {current.mode === 'create' ? <input className="input mt-10" aria-label={`Nome ${label.toLowerCase()}`} maxLength={90} disabled={!canChangeResource} value={current.name} onChange={(event) => update({ ...draft, [key]: { mode: 'create', name: event.target.value } })} /> :
        <select className="select mt-10" aria-label={label} disabled={!canChangeResource || choices.length === 0} value={current.id} onChange={(event) => update({ ...draft, [key]: { mode: 'existing', id: event.target.value } })}>
          <option value="">{choices.length ? 'Scegli una risorsa Discord' : 'Nessuna risorsa compatibile'}</option>{choices.map((item) => <option key={item.id} value={item.id}>{key === 'panelChannel' ? '#' : ''}{item.name}{key === 'ticketCategory' ? ' · privata' : ''}</option>)}
        </select>}
      {key === 'ticketCategory' && current.mode === 'existing' && <p className="help">Sono mostrate solo categorie in cui @everyone non può vedere i canali.</p>}
    </div>;
  };
  const submit = async () => {
    if (draft.categories.some((item) => !draft.staffRoleIds.length && !item.staffRoleIds.length)) { setError('Seleziona un ruolo staff generale o specifico per ogni tipologia.'); setStep(1); return; }
    if (draft.categories.some((item) => !item.fields.length)) { setError('Ogni tipologia deve avere almeno un campo nel modulo.'); setStep(1); return; }
    setBusy(true); setError(''); setOperation({ operationId: operation?.operationId ?? '', status: 'in_progress', resources: {} });
    try {
      if (panel) {
        const patch = { name: draft.name, panelTitle: draft.panelTitle, description: draft.description, color: draft.color, footer: draft.footer, layout: draft.layout, staffRoleIds: draft.staffRoleIds, maxOpenPerUser: draft.maxOpenPerUser, maxConcurrentTotal: draft.maxConcurrentTotal, cooldownSeconds: draft.cooldownSeconds, categories: draft.categories };
        const result = await api.request<{ status: string; staffAccess: { changed: number; failed: number } }>(`${base}/tickets/panels/${panel.id}`, { method: 'PATCH', body: { expectedVersion: panel.version, patch } });
        onSaved(result.status === 'needs_attention' ? 'Pannello aggiornato, ma alcune risorse o permessi richiedono riparazione.' : 'Pannello aggiornato e messaggio Discord modificato.');
      } else {
        const result = await api.request<{ operationId: string; status: string; panel?: TicketPanel; resources: Record<string, string | boolean>; error?: string }>(`${base}/tickets/panels`, { method: 'POST', body: draft, idempotencyKey: operationKey });
        setOperation(result);
        if (result.status === 'completed' && result.panel) onSaved(`Pannello attivo. Canale: https://discord.com/channels/${guild.id}/${result.panel.channelId}`);
        else setError(result.error ?? 'La creazione è ancora in corso. Puoi riprendere la stessa operazione senza creare duplicati.');
      }
    } catch (reason) { setError(errorText(reason)); onNotify('error', errorText(reason)); }
    finally { setBusy(false); }
  };
  const selectRoles = (selected: HTMLCollectionOf<HTMLOptionElement>) => [...selected].map((option) => option.value);
  return <div className="ticket-wizard-backdrop" role="presentation"><section className="ticket-wizard card" role="dialog" aria-modal="true" aria-labelledby="ticket-wizard-title">
    <div className="card-header"><div><p className="eyebrow">Procedura guidata · {guild.name}</p><h3 id="ticket-wizard-title">{panel ? 'Modifica pannello ticket' : 'Crea pannello ticket'}</h3></div><button className="button ghost small" onClick={onClose}>Chiudi</button></div>
    <div className="wizard-steps" aria-label="Passaggi della procedura">{steps.map((label, index) => <button key={label} className={`wizard-step ${step === index ? 'active' : ''}`} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}</div>
    <RemoteState loading={resources.loading} error={resources.error} onRetry={resources.refresh} />
    {busy && !error && <div className="notice" role="status">Creazione in corso. Sto attendendo la conferma di Discord sulle risorse richieste.</div>}
    {error && <div className="alert" role="alert">{error}{operation?.operationId && <div className="help mt-10">Operazione {shortId(operation.operationId)} · stato: {operationStatusLabel(operation.status)}{Object.keys(operation.resources).length ? ` · risorse registrate: ${Object.entries(operation.resources).filter(([, value]) => typeof value === 'string').map(([key, value]) => `${operationResourceLabel(key)} ${shortId(String(value))}`).join(', ')}` : ''}</div>}</div>}
    <div className="wizard-content">
      {step === 0 && <>
        <Panel title="Server Discord" subtitle="L’accesso viene ricontrollato dal backend durante la creazione.">
          <FormField label="Server"><select className="select" value={guild.id} disabled={Boolean(panel)} onChange={(event) => {
            const selected = guilds.find((item) => item.id === event.target.value);
            if (!selected || selected.id === guild.id) return;
            if (!window.confirm('Cambiare server ripristina le impostazioni della procedura guidata. Continuare?')) return;
            update(emptyPanelConfig()); setOperation(null); onGuildChange(selected);
          }}>{guilds.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></FormField>
        </Panel>
        <div className="grid two">
        <Panel title="Canale pannello" subtitle="Il pannello resta visibile al pubblico; @everyone non potrà inviare messaggi.">{choiceEditor('panelChannel', 'Canale testuale')}</Panel>
        <Panel title="Categoria del pannello" subtitle="Contiene soltanto il canale pubblico del pannello.">{choiceEditor('panelCategory', 'Categoria pannello')}</Panel>
        <Panel title="Categoria privata dei ticket" subtitle="Deve restare nascosta a @everyone. Ogni ticket riceve permessi separati per autore e staff.">{choiceEditor('ticketCategory', 'Categoria ticket privata')}</Panel>
        </div>
      </>}
      {step === 1 && <div className="grid">
        <Panel title="Ruoli staff" subtitle="Questi ruoli potranno vedere e gestire i ticket creati dal pannello.">
          <FormField label="Ruoli autorizzati" help="Puoi lasciare vuoto se assegni almeno un ruolo specifico a ogni tipologia."><select className="select" multiple value={draft.staffRoleIds} onChange={(event) => update({ ...draft, staffRoleIds: selectRoles(event.target.selectedOptions) })}>{roleChoices.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></FormField>
        </Panel>
        {draft.categories.map((category, categoryIndex) => <Panel key={category.key} title={`Tipologia ${categoryIndex + 1}`} actions={draft.categories.length > 1 ? <button className="button ghost small" onClick={() => update({ ...draft, categories: draft.categories.filter((_, index) => index !== categoryIndex) })}>Rimuovi</button> : undefined}>
          <div className="form-grid">
            <FormField label="Identificativo interno"><input className="input" maxLength={32} value={category.key} onChange={(event) => updateCategory(categoryIndex, { key: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })} /></FormField>
            <FormField label="Nome tipologia"><input className="input" maxLength={80} value={category.label} onChange={(event) => updateCategory(categoryIndex, { label: event.target.value })} /></FormField>
            <FormField label="Etichetta pulsante"><input className="input" maxLength={80} value={category.buttonLabel ?? category.label} onChange={(event) => updateCategory(categoryIndex, { buttonLabel: event.target.value })} /></FormField>
            <FormField label="Descrizione"><input className="input" maxLength={100} value={category.description} onChange={(event) => updateCategory(categoryIndex, { description: event.target.value })} /></FormField>
            <div className="span-2"><FormField label="Ruoli staff specifici (facoltativo)"><select className="select" multiple value={category.staffRoleIds} onChange={(event) => updateCategory(categoryIndex, { staffRoleIds: selectRoles(event.target.selectedOptions) })}>{roleChoices.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select><p className="help">Se lasci vuoto, si applicano i ruoli staff generali selezionati sopra.</p></FormField></div>
          </div>
          <div className="ticket-form-fields"><h4>Campi del modulo</h4>{category.fields.map((field, fieldIndex) => <div className="ticket-form-field" key={field.key}>
            <FormField label="Nome interno"><input className="input" maxLength={32} value={field.key} onChange={(event) => updateField(categoryIndex, fieldIndex, { key: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })} /></FormField>
            <FormField label="Etichetta"><input className="input" maxLength={45} value={field.label} onChange={(event) => updateField(categoryIndex, fieldIndex, { label: event.target.value })} /></FormField>
            <FormField label="Formato"><select className="select" value={field.style} onChange={(event) => updateField(categoryIndex, fieldIndex, { style: event.target.value as 'short' | 'paragraph' })}><option value="short">Testo breve (100 caratteri)</option><option value="paragraph">Testo esteso (1500 caratteri)</option></select></FormField>
            <Check label="Obbligatorio" checked={field.required} onChange={(required) => updateField(categoryIndex, fieldIndex, { required })} />
            {category.fields.length > 1 && <button className="button ghost small" onClick={() => updateCategory(categoryIndex, { fields: category.fields.filter((_, index) => index !== fieldIndex) })}>Rimuovi campo</button>}
          </div>)}
          {category.fields.length < 5 && <button className="button small" onClick={() => updateCategory(categoryIndex, { fields: [...category.fields, { key: `campo-${category.fields.length + 1}`, label: 'Nuovo campo', style: 'short', required: false }] })}>Aggiungi campo</button>}</div>
        </Panel>)}
        {draft.categories.length < 25 && <button className="button" onClick={() => update({ ...draft, categories: [...draft.categories, { key: `richiesta-${draft.categories.length + 1}`, label: 'Nuova richiesta', buttonLabel: 'Nuova richiesta', description: 'Descrivi la richiesta', staffRoleIds: [], fields: [{ key: 'descrizione', label: 'Descrizione', style: 'paragraph', required: true }] }] })}>Aggiungi tipologia</button>}
      </div>}
      {step === 2 && <Panel title="Aspetto del messaggio" subtitle="Il messaggio viene pubblicato dal bot nel canale del pannello.">
        <div className="form-grid"><FormField label="Nome pannello"><input className="input" maxLength={80} value={draft.name} onChange={(event) => update({ ...draft, name: event.target.value })} /></FormField>
          <FormField label="Colore"><input className="input color-input" type="color" value={draft.color} onChange={(event) => update({ ...draft, color: event.target.value })} /></FormField>
          <div className="span-2"><FormField label="Titolo"><input className="input" maxLength={100} value={draft.panelTitle} onChange={(event) => update({ ...draft, panelTitle: event.target.value })} /></FormField></div>
          <div className="span-2"><FormField label="Descrizione"><textarea className="textarea" maxLength={2000} value={draft.description} onChange={(event) => update({ ...draft, description: event.target.value })} /></FormField></div>
          <div className="span-2"><FormField label="Footer"><input className="input" maxLength={100} value={draft.footer} onChange={(event) => update({ ...draft, footer: event.target.value })} /></FormField></div>
          <FormField label="Controlli ticket"><select className="select" value={draft.layout} onChange={(event) => update({ ...draft, layout: event.target.value as 'menu' | 'buttons' })}><option value="menu">Menu a tendina</option><option value="buttons">Pulsanti</option></select></FormField>
        </div>
      </Panel>}
      {step === 3 && <Panel title="Limiti di apertura" subtitle="Si applicano separatamente a questo pannello.">
        <div className="form-grid"><FormField label="Ticket contemporanei per persona"><input className="input" type="number" min={1} max={10} value={draft.maxOpenPerUser} onChange={(event) => update({ ...draft, maxOpenPerUser: Number(event.target.value) })} /></FormField>
          <FormField label="Ticket contemporanei per pannello"><input className="input" type="number" min={1} max={500} value={draft.maxConcurrentTotal} onChange={(event) => update({ ...draft, maxConcurrentTotal: Number(event.target.value) })} /></FormField>
          <FormField label="Attesa prima di una nuova apertura (secondi)"><input className="input" type="number" min={0} max={86400} value={draft.cooldownSeconds} onChange={(event) => update({ ...draft, cooldownSeconds: Number(event.target.value) })} /></FormField>
        </div>
      </Panel>}
      {step === 4 && <div className="grid two">
        <Panel title="Anteprima pannello" subtitle={`Server: ${guild.name}`}>
          <div className="ticket-panel-preview"><h3>{draft.panelTitle}</h3><p>{draft.description}</p><div className="button-row">{draft.categories.map((category) => <span className="status-pill status-neutral" key={category.key}>{draft.layout === 'buttons' ? category.buttonLabel ?? category.label : category.label}</span>)}</div><p className="help">Colore embed: <code>{draft.color}</code> · {draft.footer}</p></div>
          <div className="ticket-form-preview mt-14"><h4>Anteprima modulo · {draft.categories[0]?.label ?? 'Tipologia'}</h4>{draft.categories[0]?.fields.map((field) => <div className="ticket-preview-field" key={field.key}><strong>{field.label}{field.required ? ' · obbligatorio' : ' · facoltativo'}</strong><span>{field.style === 'paragraph' ? 'Risposta estesa · fino a 1500 caratteri' : 'Risposta breve · fino a 100 caratteri'}</span></div>)}</div>
        </Panel>
        <Panel title="Riepilogo risorse Discord" subtitle="Le categorie e il canale vengono creati dal bot quando confermi.">
          <div className="detail-list"><Detail label="Server" value={guild.name} /><Detail label="Canale pannello" value={ticketResourceLabel(draft.panelChannel, channelChoices, draft.panelChannel.mode === 'create' ? '#' : '')} />
            <Detail label="Categoria pannello" value={ticketResourceLabel(draft.panelCategory, channelChoices)} />
            <Detail label="Categoria privata" value={ticketResourceLabel(draft.ticketCategory, channelChoices)} />
            <Detail label="Ruoli staff" value={draft.staffRoleIds.map((id) => roleChoices.find((role) => role.id === id)?.name ?? shortId(id)).join(', ') || 'Nessuno selezionato'} />
            <Detail label="Tipologie e moduli" value={`${draft.categories.length} tipologie · ${draft.categories.reduce((count, item) => count + item.fields.length, 0)} campi`} />
          </div>
          <div className="notice mt-14">Discord non concede accesso ai ticket per il solo fatto di essere selezionato qui: il backend verifica server, ruoli e permessi al momento di ogni operazione. Il proprietario e gli amministratori del server mantengono i normali privilegi Discord.</div>
        </Panel>
      </div>}
    </div>
    <div className="wizard-actions"><button className="button ghost" disabled={step === 0 || busy} onClick={() => setStep((value) => Math.max(0, value - 1))}>Indietro</button><span className="help">Passaggio {step + 1} di {steps.length}</span>
      {step < steps.length - 1 ? <button className="button primary" disabled={busy || (step === 0 && (!resources.data || Boolean(resources.error)))} onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))}>Continua</button> : <button className="button primary" disabled={busy || !resources.data || Boolean(resources.error)} onClick={() => void submit()}>{busy ? 'Creazione in corso…' : panel ? 'Salva e aggiorna Discord' : operation?.operationId ? 'Riprendi operazione' : 'Conferma e crea pannello'}</button>}
    </div>
  </section></div>;
}

function ReportsPage({ guild, reloadSequence, onNotify, onChanged }: Props) {
  const base = apiBase(guild.id); const [confidential, setConfidential] = useState(false); const [status, setStatus] = useState(''); const [search, setSearch] = useState(''); const [selected, setSelected] = useState(''); const [reason, setReason] = useState(''); const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ confidential: String(confidential), limit: '50', offset: String(offset) }); if (status) query.set('status', status); if (search.trim()) query.set('search', search.trim());
  const list = useRemote<{ reports: Report[] }>(`${base}/reports?${query}`, reloadSequence);
  const detail = useRemote<{ report: Report; history: ReportEvent[] }>(selected ? `${base}/reports/${selected}` : '', reloadSequence);
  const mutation = useMutation(onNotify, onChanged);
  const transition = async (next: 'assigned' | 'info_requested' | 'accepted' | 'rejected') => {
    if (!selected) return;
    if (next !== 'assigned' && reason.trim().length < 3) { onNotify('error', 'Inserisci una motivazione di almeno 3 caratteri.'); return; }
    const ok = await mutation.run(() => api.request(`${base}/reports/${selected}/status`, { method: 'POST', body: { status: next, ...(reason.trim() ? { reason: reason.trim() } : {}) } }), 'Stato segnalazione aggiornato e registrato.');
    if (ok) { setReason(''); detail.refresh(); list.refresh(); }
  };
  return <>
    <PageHeader title="Segnalazioni" description="Esamina il contenuto e registra l’esito. Le segnalazioni riservate usano un’autorizzazione separata." />
    <div className="split">
      <Panel title="Elenco segnalazioni" subtitle={confidential ? 'Vista riservata: richiede il ruolo dedicato.' : 'Vista ordinaria.'}>
        <div className="toolbar"><label className="check-row"><input type="checkbox" checked={confidential} onChange={(event) => { setConfidential(event.target.checked); setSelected(''); setOffset(0); }} />Segnalazioni riservate</label><Select label="Stato segnalazione" value={status} onChange={(value) => { setStatus(value); setOffset(0); }}><option value="">Tutti gli stati</option><option value="new">Nuova</option><option value="assigned">Assegnata</option><option value="info_requested">Info richieste</option><option value="accepted">Accettata</option><option value="rejected">Rifiutata</option></Select><input className="input search" placeholder="Cerca ID, categoria o testo" value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} /></div>
        <RemoteState loading={list.loading} error={list.error} onRetry={list.refresh} />
        {!list.loading && !list.error && !list.data?.reports.length && <Empty title="Nessuna segnalazione" />}
        {!!list.data?.reports.length && <><div className="table-wrap"><table><thead><tr><th>Data</th><th>Categoria</th><th>Stato</th><th>Utente segnalato</th><th></th></tr></thead><tbody>{list.data.reports.map((report) => <tr key={report.id}><td className="nowrap">{date(report.createdAt)}</td><td>{report.category}</td><td>{reportStatusLabel(report.status)}</td><td className="mono">{shortId(report.targetUserId)}</td><td><button className="table-action" onClick={() => setSelected(report.id)}>Esamina</button></td></tr>)}</tbody></table></div><div className="pagination"><span>{offset + 1}–{offset + list.data.reports.length}</span><div className="button-row"><button className="button small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Precedenti</button><button className="button small" disabled={list.data.reports.length < 50} onClick={() => setOffset(offset + 50)}>Successive</button></div></div></>}
      </Panel>
      {!selected ? <Panel title="Dettaglio" subtitle="Apri una segnalazione per leggere il contenuto e la cronologia."><Empty title="Nessuna segnalazione selezionata" /></Panel> : <Panel title="Dettaglio segnalazione" subtitle={detail.data ? `ID ${detail.data.report.id} · ${detail.data.report.confidential ? 'riservata' : 'ordinaria'}` : 'Caricamento'}>
        <RemoteState loading={detail.loading} error={detail.error} onRetry={detail.refresh} />
        {detail.data && <>
          <div className="detail-list"><Detail label="Categoria" value={detail.data.report.category} /><Detail label="Segnalante" value={detail.data.report.reporterId} /><Detail label="Utente segnalato" value={detail.data.report.targetUserId ?? 'Non indicato'} /><Detail label="ID Roblox" value={detail.data.report.robloxId ?? 'Non indicato'} /><Detail label="Descrizione" value={detail.data.report.description} /><Detail label="Prove" value={detail.data.report.evidence ?? 'Nessuna'} /><Detail label="Stato attuale" value={reportStatusLabel(detail.data.report.status)} /><Detail label="Assegnata a" value={detail.data.report.assignedTo ?? 'Nessuno'} /></div>
          <div className="field mt-15"><label htmlFor="report-reason">Motivazione / richiesta informazioni</label><textarea id="report-reason" className="textarea" maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Obbligatoria per chiedere informazioni, accettare o rifiutare" /></div>
          <div className="button-row mt-11"><button className="button" disabled={mutation.busy} onClick={() => void transition('assigned')}>Assegna a me</button><button className="button" disabled={mutation.busy || reason.trim().length < 3} onClick={() => void transition('info_requested')}>Chiedi informazioni</button><button className="button primary" disabled={mutation.busy || reason.trim().length < 3} onClick={() => void transition('accepted')}>Accetta</button><button className="button danger" disabled={mutation.busy || reason.trim().length < 3} onClick={() => void transition('rejected')}>Rifiuta</button></div>
          <h4 className="mt-20">Cronologia</h4>{detail.data.history.map((event, index) => <div className="activity-item" key={`${event.createdAt}-${index}`}><span className="activity-dot" /><div><div className="activity-title">{reportEventLabel(event.eventType)} · {shortId(event.actorId)}</div><div className="activity-detail">{event.detail ?? '—'}</div></div><time className="activity-time">{date(event.createdAt)}</time></div>)}
        </>}
      </Panel>}
    </div>
  </>;
}

function ModerationPage({ guild, reloadSequence, onNotify, onChanged }: Props) {
  const base = apiBase(guild.id); const [targetId, setTargetId] = useState(''); const [reason, setReason] = useState(''); const [duration, setDuration] = useState(60); const [caseTarget, setCaseTarget] = useState(''); const [channelId, setChannelId] = useState(''); const [amount, setAmount] = useState(10); const [slowSeconds, setSlowSeconds] = useState(5); const [channelReason, setChannelReason] = useState('');
  const [warningsTarget, setWarningsTarget] = useState(''); const [warnings, setWarnings] = useState<Warning[] | null>(null); const [warningError, setWarningError] = useState(''); const [busy, setBusy] = useState(false);
  const casesQuery = caseTarget.trim() ? `?targetId=${encodeURIComponent(caseTarget.trim())}&limit=50` : '?limit=50';
  const cases = useRemote<{ cases: ModerationCase[] }>(`${base}/moderation/cases${casesQuery}`, reloadSequence);
  const resources = useRemote<GuildResources>(`${base}/resources`, reloadSequence);
  const mutation = useMutation(onNotify, onChanged);
  const run = async (path: string, method: string, body: unknown, label: string) => mutation.run(() => api.request(path, { method, body }), label);
  const requestConfirmed = async (path: string, body: unknown, actionName: string) => {
    setBusy(true);
    try {
      const { confirmationId, expiresAt } = await api.request<{ confirmationId: string; expiresAt: string }>(path, { method: 'POST', body });
      if (!window.confirm(`${actionName}. Conferma entro ${date(expiresAt)}?`)) { onNotify('success', 'Operazione non confermata; nessuna azione eseguita.'); return; }
      await api.request(`${base}/moderation/confirmations/${confirmationId}`, { method: 'POST', body: {} });
      onChanged(`${actionName} completata e registrata.`);
    } catch (error) { onNotify('error', errorText(error)); }
    finally { setBusy(false); }
  };
  const loadWarnings = async () => {
    if (!/^\d{17,20}$/.test(warningsTarget)) { setWarningError('Inserisci un ID Discord valido.'); return; }
    setWarningError(''); setWarnings(null);
    try { const result = await api.request<{ warnings: Warning[] }>(`${base}/moderation/${warningsTarget}/warnings`); setWarnings(result.warnings); }
    catch (error) { setWarningError(errorText(error)); }
  };
  const revokeWarning = async (warning: Warning) => {
    const why = window.prompt(`Motivo per revocare l’avvertimento #${warning.caseNumber}:`);
    if (!why || why.trim().length < 3) return;
    await mutation.run(() => api.request(`${base}/moderation/warnings/${warning.caseNumber}/revoke`, { method: 'POST', body: { reason: why.trim() } }), 'Avvertimento revocato e registrato.');
    await loadWarnings();
  };
  return <>
    <PageHeader title="Moderazione" description="Azioni Discord registrate con controlli server-side su permessi, ruoli e gerarchie." />
    <div className="grid two">
      <Panel title="Azioni su un utente" subtitle="Ogni operazione richiede ID Discord e motivazione.">
        <div className="form-grid">
          <FormField label="ID utente Discord"><input className="input" inputMode="numeric" value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="17–20 cifre" /></FormField>
          <FormField label="Durata timeout (minuti)"><input className="input" type="number" min={1} max={40320} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></FormField>
          <div className="span-2"><FormField label="Motivazione"><textarea className="textarea" maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Motivo visibile nel registro moderazione" /></FormField></div>
        </div>
        <div className="button-row mt-14">
          <button className="button" disabled={mutation.busy || busy || !validAction(targetId, reason)} onClick={() => void run(`${base}/moderation/warnings`, 'POST', { targetId, reason: reason.trim() }, 'Avvertimento registrato.')}>Avverti</button>
          <button className="button" disabled={mutation.busy || busy || !validAction(targetId, reason) || duration < 1 || duration > 40320} onClick={() => void run(`${base}/moderation/timeouts`, 'POST', { targetId, durationMinutes: duration, reason: reason.trim() }, 'Timeout applicato.')}>Timeout</button>
          <button className="button" disabled={mutation.busy || busy || !validAction(targetId, reason)} onClick={() => void run(`${base}/moderation/kicks`, 'POST', { targetId, reason: reason.trim() }, 'Utente espulso.')}>Espelli</button>
          <button className="button danger" disabled={mutation.busy || busy || !validAction(targetId, reason)} onClick={() => void requestConfirmed(`${base}/moderation/bans/confirmations`, { targetId, reason: reason.trim() }, 'Bannare l’utente')}>Richiedi ban</button>
          <button className="button" disabled={mutation.busy || busy || !validAction(targetId, reason)} onClick={() => void run(`${base}/moderation/unbans`, 'POST', { targetId, reason: reason.trim() }, 'Ban rimosso.')}>Sban</button>
          <button className="button ghost" disabled={mutation.busy || busy || !validAction(targetId, reason)} onClick={() => void api.request(`${base}/moderation/${targetId}/timeouts`, { method: 'DELETE', body: { reason: reason.trim() } }).then(() => onChanged('Timeout rimosso.')).catch((error: unknown) => onNotify('error', errorText(error)))}>Rimuovi timeout</button>
        </div>
        <p className="help">Ban e cancellazione messaggi richiedono una seconda conferma esplicita, valida per cinque minuti.</p>
      </Panel>
      <Panel title="Avvertimenti" subtitle="Consulta e revoca avvertimenti usando le API reali.">
        <div className="inline-form"><FormField label="ID utente"><input className="input" inputMode="numeric" value={warningsTarget} onChange={(event) => setWarningsTarget(event.target.value)} /></FormField><button className="button" onClick={() => void loadWarnings()}>Cerca</button></div>
        {warningError && <p className="error-text">{warningError}</p>}
        {warnings && (warnings.length ? <div className="table-wrap mt-13"><table><thead><tr><th>Caso</th><th>Motivo</th><th>Stato</th><th></th></tr></thead><tbody>{warnings.map((warning) => <tr key={warning.caseNumber}><td>#{warning.caseNumber}</td><td className="text-cell">{warning.reason}</td><td>{warning.revokedAt ? `Revocato ${date(warning.revokedAt)}` : 'Attivo'}</td><td>{!warning.revokedAt && <button className="table-action" onClick={() => void revokeWarning(warning)}>Revoca</button>}</td></tr>)}</tbody></table></div> : <Empty title="Nessun avvertimento registrato" />)}
      </Panel>
      <Panel title="Svuota messaggi" subtitle="La cancellazione richiede conferma server-side prima dell’esecuzione.">
        <div className="form-grid"><FormField label="Canale"><Select label="Canale per cancellazione messaggi" value={resources.data?.channels.some((channel) => channel.id === channelId) ? channelId : ''} onChange={setChannelId}><option value="">Scegli canale testuale</option>{resources.data?.channels.filter((item) => item.type === 0 || item.type === 5).map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</Select></FormField><FormField label="ID canale Discord"><input className="input" inputMode="numeric" value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="ID, se non puoi caricare l’elenco" /></FormField><FormField label="Messaggi recenti (2–100)"><input className="input" type="number" min={2} max={100} value={amount} onChange={(event) => setAmount(Number(event.target.value))} /></FormField></div>
        <div className="form-actions"><button className="button danger" disabled={busy || !channelId || amount < 2 || amount > 100} onClick={() => void requestConfirmed(`${base}/moderation/purges/confirmations`, { channelId, amount }, `Eliminare ${amount} messaggi`)}>Richiedi eliminazione</button></div>
      </Panel>
      <Panel title="Slowmode canale" subtitle="Imposta un intervallo da 0 a 21.600 secondi; 0 disattiva lo slowmode.">
        <div className="form-grid"><FormField label="Canale"><Select label="Canale per slowmode" value={resources.data?.channels.some((channel) => channel.id === channelId) ? channelId : ''} onChange={setChannelId}><option value="">Scegli canale testuale</option>{resources.data?.channels.filter((item) => item.type === 0).map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</Select></FormField><FormField label="ID canale Discord"><input className="input" inputMode="numeric" value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="ID canale Discord" /></FormField><FormField label="Secondi"><input className="input" type="number" min={0} max={21600} value={slowSeconds} onChange={(event) => setSlowSeconds(Number(event.target.value))} /></FormField><div className="span-2"><FormField label="Motivo slowmode"><input className="input" maxLength={1000} value={channelReason} onChange={(event) => setChannelReason(event.target.value)} /></FormField></div></div>
        <div className="form-actions"><button className="button" disabled={mutation.busy || !/^\d{17,20}$/.test(channelId) || channelReason.trim().length < 3 || slowSeconds < 0 || slowSeconds > 21600} onClick={() => { if (window.confirm(`Impostare slowmode a ${slowSeconds} secondi?`)) void run(`${base}/moderation/slowmode`, 'POST', { channelId, seconds: slowSeconds, reason: channelReason.trim() }, 'Slowmode aggiornato e registrato.'); }}>Applica slowmode</button></div>
      </Panel>
      <Panel title="Registro casi" subtitle="Ultimi casi restituiti dal backend, filtrabili per ID utente.">
        <div className="toolbar"><input className="input search" placeholder="Filtra per ID utente Discord" value={caseTarget} onChange={(event) => setCaseTarget(event.target.value)} /><button className="button small" onClick={cases.refresh}>Aggiorna</button></div>
        <RemoteState loading={cases.loading} error={cases.error} onRetry={cases.refresh} />
        {!cases.loading && !cases.error && !cases.data?.cases.length && <Empty title="Nessun caso trovato" />}
        {!!cases.data?.cases.length && <div className="table-wrap"><table><thead><tr><th>#</th><th>Azione</th><th>Utente / risorsa</th><th>Motivo</th><th>Esito</th><th>Data</th></tr></thead><tbody>{cases.data.cases.map((item) => <tr key={item.caseNumber}><td>#{item.caseNumber}</td><td>{moderationActionLabel(item.action)}</td><td className="mono">{shortId(item.targetId)}</td><td className="text-cell">{item.reason}</td><td>{moderationResultLabel(item.result)}</td><td className="nowrap">{date(item.createdAt)}</td></tr>)}</tbody></table></div>}
      </Panel>
    </div>
  </>;
}
function validAction(targetId: string, reason: string) { return /^\d{17,20}$/.test(targetId) && reason.trim().length >= 3; }

function SecurityPage({ guild, reloadSequence, onNotify, onChanged }: Props) {
  const base = apiBase(guild.id); const settingsRemote = useRemote<StoredSettings>(`${base}/settings`, reloadSequence);
  const diagnostics = useRemote<{ botReady: boolean; guildAvailable: boolean; modules: GuildSettings['modules']; channels: Array<{ purpose: string; configured: boolean; available: boolean }>; automationStopped: boolean }>(`${base}/diagnostics`, reloadSequence);
  const resources = useRemote<GuildResources>(`${base}/resources`, reloadSequence);
  const [draft, setDraft] = useState<GuildSettings['security'] | null>(null); const [duration, setDuration] = useState(30); const [channelId, setChannelId] = useState(''); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (settingsRemote.data) setDraft(settingsRemote.data.settings.security); }, [settingsRemote.data]);
  const save = async () => {
    if (!draft || !settingsRemote.data) return;
    setBusy(true);
    try { const result = await api.request<{ applicationStatus?: string }>(`${base}/settings`, { method: 'PATCH', body: { expectedVersion: settingsRemote.data.version, settings: { security: draft } } }); onChanged(result.applicationStatus === 'parziale' ? 'Sicurezza salvata con una o più sincronizzazioni incomplete.' : 'Impostazioni sicurezza salvate e sincronizzate.'); }
    catch (error) { onNotify('error', errorText(error)); }
    finally { setBusy(false); }
  };
  const execute = async (path: string, body: unknown, label: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); try { const result = await api.request<Record<string, unknown>>(path, { method: 'POST', body }); onChanged(`${label}: ${json(result)}`); }
    catch (error) { onNotify('error', errorText(error)); } finally { setBusy(false); }
  };
  const lockdown = async () => {
    setBusy(true);
    try {
      const result = await api.request<{ confirmationId: string; expiresAt: string }>(`${base}/security/lockdown`, { method: 'POST', body: { durationMinutes: duration } });
      if (!window.confirm(`Richiesta di lockdown creata. Attivare il blocco dei canali per ${duration} minuti?`)) { onNotify('success', 'Lockdown non attivato; la richiesta di conferma scadrà automaticamente.'); return; }
      const activated = await api.request(`${base}/security/lockdown/confirmations/${result.confirmationId}`, { method: 'POST', body: {} });
      onChanged(`Lockdown completato: ${json(activated)}`);
    } catch (error) { onNotify('error', errorText(error)); } finally { setBusy(false); }
  };
  return <>
    <PageHeader title="Sicurezza" description="Configura Anti-Raid e AutoMod, verifica i canali e attiva i controlli emergenza." />
    <div className="grid two">
      <Panel title="Diagnostica sicurezza" subtitle="Dati dal bot e risorse Discord correnti.">
        <RemoteState loading={diagnostics.loading} error={diagnostics.error} onRetry={diagnostics.refresh} />
        {diagnostics.data && <div className="detail-list"><Detail label="Bot" value={diagnostics.data.botReady ? 'Connesso' : 'Non connesso'} /><Detail label="Server Discord" value={diagnostics.data.guildAvailable ? 'Disponibile' : 'Non disponibile'} /><Detail label="Automazioni" value={diagnostics.data.automationStopped ? 'Sospese' : 'Attive'} />{diagnostics.data.channels.map((channel) => <Detail key={channel.purpose} label={channel.purpose} value={!channel.configured ? 'Non configurato' : channel.available ? 'OK' : 'Non trovato'} />)}</div>}
      </Panel>
      <Panel title="Risposta emergenza" subtitle="Lockdown usa una doppia conferma e snapshot per ripristinare solo permessi non modificati manualmente.">
        <div className="form-grid"><FormField label="Durata lockdown (minuti)"><input className="input" type="number" min={1} max={1440} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></FormField><FormField label="Canale per blocco singolo"><Select label="Canale da bloccare" value={channelId} onChange={setChannelId}><option value="">Scegli canale testuale</option>{resources.data?.channels.filter((item) => item.compatible.lockdown).map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</Select></FormField><div className="span-2"><FormField label="Motivazione"><input className="input" minLength={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Motivo registrato nel registro moderazione" /></FormField></div></div>
        <div className="button-row mt-13"><button className="button danger" disabled={busy || duration < 1 || duration > 1440} onClick={() => void lockdown()}>Richiedi lockdown server</button><button className="button" disabled={busy} onClick={() => void execute(`${base}/security/restore`, {}, 'Ripristino completato', 'Ripristinare i permessi dei canali modificati dal lockdown?')}>Ripristina canali</button></div>
        <div className="button-row mt-10"><button className="button" disabled={busy || !channelId || reason.trim().length < 3} onClick={() => void execute(`${base}/security/channels/lock`, { channelId, reason: reason.trim() }, 'Canale bloccato', 'Bloccare l’invio in questo canale Discord?')}>Blocca solo questo canale</button><button className="button" disabled={busy || !channelId || reason.trim().length < 3} onClick={() => void execute(`${base}/security/channels/unlock`, { channelId, reason: reason.trim() }, 'Canale sbloccato', 'Ripristinare il permesso di invio registrato dal bot?')}>Sblocca canale</button></div>
        <div className="button-row mt-10"><button className="button" disabled={busy} onClick={() => void execute(`${base}/security/automations/stop`, {}, 'Automazioni sospese', 'Sospendere temporaneamente tutte le automazioni di sicurezza?')}>Sospendi automazioni</button><button className="button" disabled={busy} onClick={() => void execute(`${base}/security/automations/start`, {}, 'Automazioni riattivate', 'Riattivare le automazioni di sicurezza?')}>Riattiva automazioni</button></div>
      </Panel>
      {draft && settingsRemote.data && <Panel title="Anti-Raid e AutoMod" subtitle="Le modifiche vengono validate e applicate con la versione corrente delle impostazioni." actions={<button className="button primary small" disabled={busy} onClick={() => void save()}>Salva sicurezza</button>}>
        <div className="form-grid">
          <FormField label="Modalità"><Select label="Modalità sicurezza" value={draft.mode} onChange={(value) => setDraft({ ...draft, mode: value as typeof draft.mode })}><option value="observe">Osserva</option><option value="alert">Avvisa</option><option value="enforce">Applica protezioni</option></Select></FormField>
          <FormField label="Soglia raffica ingressi"><input className="input" type="number" min={2} max={1000} value={draft.joinSpikeCount} onChange={(event) => setDraft({ ...draft, joinSpikeCount: Number(event.target.value) })} /></FormField>
          <FormField label="Finestra raffica (secondi)"><input className="input" type="number" min={5} max={3600} value={draft.joinSpikeWindowSeconds} onChange={(event) => setDraft({ ...draft, joinSpikeWindowSeconds: Number(event.target.value) })} /></FormField>
          <FormField label="Età account nuova (giorni)"><input className="input" type="number" min={0} max={30} value={draft.newAccountDays} onChange={(event) => setDraft({ ...draft, newAccountDays: Number(event.target.value) })} /></FormField>
          <FormField label="Messaggi duplicati"><input className="input" type="number" min={2} max={20} value={draft.duplicateMessageLimit} onChange={(event) => setDraft({ ...draft, duplicateMessageLimit: Number(event.target.value) })} /></FormField>
          <FormField label="Finestra duplicati (secondi)"><input className="input" type="number" min={2} max={3600} value={draft.duplicateWindowSeconds} onChange={(event) => setDraft({ ...draft, duplicateWindowSeconds: Number(event.target.value) })} /></FormField>
          <FormField label="Limite menzioni"><input className="input" type="number" min={1} max={100} value={draft.mentionLimit} onChange={(event) => setDraft({ ...draft, mentionLimit: Number(event.target.value) })} /></FormField>
          <div className="span-2"><FormField label="Domini bloccati (uno per riga)"><textarea className="textarea" value={draft.blockedDomains.join('\n')} onChange={(event) => setDraft({ ...draft, blockedDomains: lines(event.target.value) })} /></FormField></div>
          <div className="span-2"><FormField label="Domini consentiti (uno per riga)"><textarea className="textarea" value={draft.allowedDomains.join('\n')} onChange={(event) => setDraft({ ...draft, allowedDomains: lines(event.target.value) })} /></FormField></div>
          <div className="span-2"><FormField label="Parole AutoMod bloccate (una per riga)"><textarea className="textarea" value={draft.automod.blockedWords.join('\n')} onChange={(event) => setDraft({ ...draft, automod: { ...draft.automod, blockedWords: lines(event.target.value) } })} /></FormField></div>
          <div className="span-2 checkbox-grid">
            <Check label="Abilita azioni automatiche" checked={draft.automatedActionsEnabled} onChange={(checked) => setDraft({ ...draft, automatedActionsEnabled: checked })} />
            <Check label="Consenti inviti Discord" checked={draft.allowInvites} onChange={(checked) => setDraft({ ...draft, allowInvites: checked })} />
            <Check label="Abilita AutoMod" checked={draft.automod.enabled} onChange={(checked) => setDraft({ ...draft, automod: { ...draft.automod, enabled: checked } })} />
          </div>
        </div>
      </Panel>}
    </div>
  </>;
}
function lines(value: string) { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="check-row"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

interface AnnouncementEmbed { title?: string; description?: string; color?: number; footer?: { text?: string }; fields?: Array<{ name: string; value: string; inline?: boolean }> }
function AnnouncementsPage({ guild, reloadSequence, onNotify, onChanged }: Props) {
  const base = apiBase(guild.id); const tasks = useRemote<{ announcements: ScheduledAnnouncement[] }>(`${base}/announcements`, reloadSequence);
  const resourceRemote = useRemote<GuildResources>(`${base}/resources`, reloadSequence); const settings = useRemote<StoredSettings>(`${base}/settings`, reloadSequence);
  const [type, setType] = useState<'annuncio' | 'manutenzione' | 'aggiornamento' | 'evento'>('annuncio'); const [title, setTitle] = useState(''); const [content, setContent] = useState(''); const [channelId, setChannelId] = useState(''); const [roleIds, setRoleIds] = useState<string[]>([]); const [runAt, setRunAt] = useState('');
  const [preview, setPreview] = useState<AnnouncementEmbed | null>(null); const [editing, setEditing] = useState<ScheduledAnnouncement | null>(null); const [busy, setBusy] = useState(false);
  const mutation = useMutation(onNotify, onChanged);
  const input = useMemo(() => ({ type, title: title.trim(), content: content.trim(), roleIds, ...(channelId ? { channelId } : {}), ...(runAt ? { runAt: new Date(runAt).toISOString() } : {}) }), [type, title, content, roleIds, channelId, runAt]);
  const previewAnnouncement = async () => {
    if (!title.trim() || !content.trim()) { onNotify('error', 'Titolo e contenuto sono obbligatori.'); return; }
    setBusy(true); setPreview(null);
    try { const result = await api.request<{ embed: AnnouncementEmbed }>(`${base}/announcements/preview`, { method: 'POST', body: input }); setPreview(result.embed); }
    catch (error) { onNotify('error', errorText(error)); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!preview) { onNotify('error', 'Genera prima un’anteprima aggiornata.'); return; }
    if (!window.confirm(editing ? 'Salvare le modifiche alla programmazione?' : runAt ? 'Programmare questo annuncio?' : 'Pubblicare questo annuncio nel canale Discord selezionato?')) return;
    setBusy(true);
    try {
      if (editing) await api.request(`${base}/announcements/${editing.id}`, { method: 'PATCH', body: { expectedVersion: editing.version, patch: input } });
      else await api.request(`${base}/announcements`, { method: 'POST', body: input });
      setEditing(null); setPreview(null); onChanged(editing ? 'Annuncio programmato aggiornato.' : runAt ? 'Annuncio programmato.' : 'Annuncio pubblicato su Discord.');
      setTitle(''); setContent(''); setRoleIds([]); setRunAt('');
    } catch (error) { onNotify('error', errorText(error)); }
    finally { setBusy(false); }
  };
  const editTask = (task: ScheduledAnnouncement) => {
    setEditing(task); setType(task.input.type); setTitle(task.input.title); setContent(task.input.content); setChannelId(task.input.channelId ?? ''); setRoleIds(task.input.roleIds ?? []); setRunAt(task.input.runAt ? toLocalInput(task.input.runAt) : toLocalInput(task.runAt)); setPreview(null);
  };
  const cancelTask = async (task: ScheduledAnnouncement) => {
    if (!window.confirm(`Annullare l’annuncio programmato “${task.input.title}”?`)) return;
    await mutation.run(() => api.request(`${base}/announcements/${task.id}`, { method: 'DELETE' }), 'Programmazione annullata.');
  };
  const selectableRoles = resourceRemote.data?.roles.filter((role) => settings.data?.settings.announcements.allowedRoleMentions.includes(role.id)) ?? [];
  return <>
    <PageHeader title="Annunci e avvisi" description="Anteprima del messaggio effettivo e conferma esplicita prima di pubblicare o programmare." />
    <div className="grid two">
      <Panel title={editing ? `Modifica programmazione · ${shortId(editing.id)}` : 'Componi annuncio'} subtitle="Le menzioni sono limitate ai ruoli consentiti nelle impostazioni del server.">
        <div className="form-grid">
          <FormField label="Tipo"><Select label="Tipo annuncio" value={type} onChange={(value) => { setType(value as typeof type); setPreview(null); }}><option value="annuncio">Annuncio</option><option value="manutenzione">Manutenzione</option><option value="aggiornamento">Aggiornamento</option><option value="evento">Evento</option></Select></FormField>
          <FormField label="Canale"><Select label="Canale annuncio" value={channelId} onChange={(value) => { setChannelId(value); setPreview(null); }}><option value="">Canale predefinito dalle impostazioni</option>{resourceRemote.data?.channels.filter((item) => item.compatible.announcements).map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</Select></FormField>
          <div className="span-2"><FormField label="Titolo"><input className="input" maxLength={100} value={title} onChange={(event) => { setTitle(event.target.value); setPreview(null); }} /></FormField></div>
          <div className="span-2"><FormField label="Contenuto"><textarea className="textarea" maxLength={4000} value={content} onChange={(event) => { setContent(event.target.value); setPreview(null); }} /></FormField></div>
          <FormField label="Programma per"><input className="input" type="datetime-local" value={runAt} onChange={(event) => { setRunAt(event.target.value); setPreview(null); }} /><p className="help">Lascia vuoto per pubblicare subito. Orario locale del browser.</p></FormField>
          <FormField label="Ruoli menzionabili"><select className="select" multiple value={roleIds} onChange={(event) => { setRoleIds([...event.target.selectedOptions].map((option) => option.value)); setPreview(null); }}>{selectableRoles.map((role) => <option key={role.id} value={role.id}>@{role.name}</option>)}</select><p className="help">Solo ruoli autorizzati nelle impostazioni Annunci.</p></FormField>
        </div>
        <div className="form-actions"><button className="button" disabled={busy} onClick={() => void previewAnnouncement()}>Aggiorna anteprima</button>{editing && <button className="button ghost" onClick={() => { setEditing(null); setPreview(null); }}>Annulla modifica</button>}<button className="button primary" disabled={busy || !preview} onClick={() => void submit()}>{editing ? 'Salva programmazione' : runAt ? 'Conferma programmazione' : 'Conferma pubblicazione'}</button></div>
      </Panel>
      <Panel title="Anteprima Discord" subtitle="Rappresentazione del contenuto che l’API invierà.">
        {!preview ? <Empty title="Anteprima non generata" /> : <div className="card announcement-preview"><h3>{preview.title}</h3><p className="pre-wrap">{preview.description}</p>{preview.fields?.map((field, index) => <Detail key={`${field.name}-${index}`} label={field.name} value={field.value} />)}<p className="help">{preview.footer?.text ?? ''}</p><p className="help">Destinazione: {channelId ? `#${resourceRemote.data?.channels.find((channel) => channel.id === channelId)?.name ?? channelId}` : 'canale annunci configurato'}</p>{roleIds.length > 0 && <p className="help">Menzioni consentite: {roleIds.map((id) => resourceRemote.data?.roles.find((role) => role.id === id)?.name ?? id).join(', ')}</p>}</div>}
      </Panel>
      <Panel title="Programmazioni" subtitle="Elenco dei task schedulati salvati nel backend.">
        <RemoteState loading={tasks.loading} error={tasks.error} onRetry={tasks.refresh} />
        {!tasks.loading && !tasks.error && !tasks.data?.announcements.length && <Empty title="Nessuna programmazione" />}
        {!!tasks.data?.announcements.length && <div className="table-wrap"><table><thead><tr><th>Data</th><th>Titolo</th><th>Stato</th><th></th></tr></thead><tbody>{tasks.data.announcements.map((task) => <tr key={task.id}><td className="nowrap">{date(task.runAt)}</td><td>{task.input.title}</td><td>{announcementStatusLabel(task.status)}{task.lastError ? <div className="error-text">{task.lastError}</div> : null}</td><td className="nowrap">{task.status === 'pending' && <><button className="table-action" onClick={() => editTask(task)}>Modifica</button> · <button className="table-action" onClick={() => void cancelTask(task)}>Annulla</button></>}</td></tr>)}</tbody></table></div>}
      </Panel>
    </div>
  </>;
}
function toLocalInput(value: string) { const dateValue = new Date(value); const offset = dateValue.getTimezoneOffset() * 60_000; return new Date(dateValue.getTime() - offset).toISOString().slice(0, 16); }

function ResourcesPage({ guild, reloadSequence, onNotify, onChanged }: Props) {
  const base = apiBase(guild.id); const resources = useRemote<GuildResources>(`${base}/resources`, reloadSequence); const stored = useRemote<StoredSettings>(`${base}/settings`, reloadSequence);
  const [draft, setDraft] = useState<GuildSettings | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (stored.data) setDraft(stored.data.settings); }, [stored.data]);
  const channelOptions = resources.data?.channels ?? []; const roleOptions = resources.data?.roles ?? [];
  const save = async () => {
    if (!draft || !stored.data) return; setBusy(true);
    try {
      const result = await api.request<{ applicationStatus: string }>(`${base}/settings`, { method: 'PATCH', body: { expectedVersion: stored.data.version, settings: { channels: draft.channels, permissions: draft.permissions, announcements: draft.announcements, tickets: draft.tickets } } });
      onChanged(result.applicationStatus === 'parziale' ? 'Risorse salvate, ma una sincronizzazione live è incompleta.' : 'Canali, ruoli e categorie ticket aggiornati.');
    } catch (error) { onNotify('error', errorText(error)); } finally { setBusy(false); }
  };
  const channelKeys: Array<[keyof GuildSettings['channels'], string, keyof GuildResources['channels'][number]['compatible']]> = [
    ['logs', 'Registro log', 'staffText'], ['announcements', 'Annunci predefiniti', 'announcements'], ['welcome', 'Benvenuto', 'staffText'],
    ['ticketParent', 'Categoria ticket', 'ticketCategory'], ['ticketPanel', 'Pannello ticket', 'ticketPanel'], ['reports', 'Segnalazioni', 'staffText'],
    ['confidentialReports', 'Segnalazioni riservate', 'staffText'], ['securityAlerts', 'Avvisi sicurezza', 'staffText'],
  ];
  const capabilityLabels: Array<[keyof GuildSettings['permissions']['roles'], string]> = [['ticketStaff', 'Staff ticket'], ['reportStaff', 'Staff segnalazioni'], ['confidentialReportStaff', 'Staff segnalazioni riservate'], ['moderate', 'Moderatori'], ['configure', 'Amministratori del sito']];
  return <>
    <PageHeader title="Ruoli e canali" description="Seleziona risorse effettive del server e controlla i permessi del bot prima di salvare." actions={<button className="button primary" disabled={busy || !draft} onClick={() => void save()}>Salva risorse</button>} />
    <RemoteState loading={resources.loading || stored.loading} error={resources.error || stored.error} onRetry={() => { resources.refresh(); stored.refresh(); }} />
    {draft && resources.data && <div className="grid two">
      <Panel title="Canali e categorie" subtitle="La compatibilità considera tipo canale e permessi correnti del bot.">
        <div className="form-grid">{channelKeys.map(([key, label, compatible]) => <FormField key={key} label={label}><Select label={label} value={draft.channels[key] ?? ''} onChange={(value) => setDraft({ ...draft, channels: { ...draft.channels, [key]: value || null } })}><option value="">Non configurato</option>{channelOptions.filter((channel) => channel.compatible[compatible]).map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</Select></FormField>)}</div>
        {channelOptions.some((channel) => !channel.permissions.view) && <p className="resource-warning">Il bot non può visualizzare alcuni canali. L’API segnala i canali compatibili in base ai permessi attuali.</p>}
      </Panel>
      <Panel title="Ruoli di accesso" subtitle="I ruoli sono verificati dal backend su ogni operazione; il bot deve essere presente nel server.">
        <div className="form-grid">{capabilityLabels.map(([key, label]) => <FormField key={key} label={label}><select className="select" multiple value={draft.permissions.roles[key]} onChange={(event) => setDraft({ ...draft, permissions: { ...draft.permissions, roles: { ...draft.permissions.roles, [key]: [...event.target.selectedOptions].map((option) => option.value) } } })}>{roleOptions.map((role) => <option key={role.id} value={role.id}>{role.name}{role.position >= resources.data!.bot.highestRolePosition ? ' · sopra il ruolo bot' : ''}</option>)}</select></FormField>)}</div>
      </Panel>
      <Panel title="Ruoli per menzioni annuncio" subtitle="Solo questi ruoli sono selezionabili nel compositore annunci.">
        <select className="select" multiple value={draft.announcements.allowedRoleMentions} onChange={(event) => setDraft({ ...draft, announcements: { allowedRoleMentions: [...event.target.selectedOptions].map((option) => option.value) } })}>{roleOptions.map((role) => <option key={role.id} value={role.id}>@{role.name}</option>)}</select>
      </Panel>
      <Panel title="Staff per categoria ticket" subtitle="Ruoli autorizzati a vedere i ticket delle singole categorie. Il bot può segnalare gerarchie o permessi insufficienti.">
        {draft.tickets.categories.map((category, index) => <div key={category.key} className="field mb-14"><label>{category.label} · {category.key}</label><select className="select" multiple value={category.staffRoleIds} onChange={(event) => { const categories = [...draft.tickets.categories]; const current = categories[index]; if (current) categories[index] = { ...current, staffRoleIds: [...event.target.selectedOptions].map((option) => option.value) }; setDraft({ ...draft, tickets: { ...draft.tickets, categories } }); }}>{roleOptions.map((role) => <option key={role.id} value={role.id}>{role.name}{!role.assignable ? ' · non gestibile dal bot' : ''}</option>)}</select></div>)}
      </Panel>
    </div>}
  </>;
}

function ActivityPage({ guild, reloadSequence }: Props) {
  const remote = useRemote<{ records: AuditRecord[] }>(`${apiBase(guild.id)}/audit-log`, reloadSequence); const [search, setSearch] = useState('');
  const records = useMemo(() => (remote.data?.records ?? []).filter((record) => `${record.actorId} ${auditActionLabel(record.action)} ${auditTargetLabel(record.targetType)} ${record.targetId ?? ''} ${auditResultLabel(record.result)}`.toLowerCase().includes(search.toLowerCase())), [remote.data, search]);
  return <>
    <PageHeader title="Registro attività" description="Eventi salvati dal backend con responsabile, destinazione ed esito." />
    <Panel title="Registro di controllo" subtitle="Ultime 100 operazioni disponibili per questo server.">
      <div className="toolbar"><input className="input search" placeholder="Filtra azione, operatore, ID o esito" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="button small" onClick={remote.refresh}>Aggiorna</button></div>
      <RemoteState loading={remote.loading} error={remote.error} onRetry={remote.refresh} />
      {!remote.loading && !remote.error && !records.length && <Empty title="Nessun evento corrispondente" />}
      {!!records.length && <div className="table-wrap"><table><thead><tr><th>Data</th><th>Operatore</th><th>Azione</th><th>Oggetto</th><th>Esito</th><th>Dettagli prima/dopo</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td className="nowrap">{date(record.createdAt)}</td><td className="mono">{record.actorId}</td><td>{auditActionLabel(record.action)}</td><td>{auditTargetLabel(record.targetType)}<br /><span className="mono">{record.targetId ?? '—'}</span></td><td>{auditResultLabel(record.result)}</td><td className="text-cell"><details><summary>Apri dettagli</summary><pre className="pre-wrap">{json({ before: record.before, after: record.after })}</pre></details></td></tr>)}</tbody></table></div>}
    </Panel>
  </>;
}

function SettingsPage({ guild, reloadSequence, onNotify, onChanged, onNavigate }: Props) {
  const base = apiBase(guild.id); const remote = useRemote<StoredSettings>(`${base}/settings`, reloadSequence); const history = useRemote<{ changes: AuditRecord[] }>(`${base}/settings/history`, reloadSequence);
  const [draft, setDraft] = useState(''); const [preview, setPreview] = useState<{ preview: GuildSettings; currentVersion: number; changedSections: string[]; willApplyWithoutRestart: string[] } | null>(null); const [busy, setBusy] = useState(false);

  const quick = useMemo(() => { try { return JSON.parse(draft) as Partial<GuildSettings>; } catch { return null; } }, [draft]);
  useEffect(() => { if (remote.data) { setDraft(json(remote.data.settings)); setPreview(null); } }, [remote.data]);
  const updateDraftValue = (path: string[], value: unknown) => {
    try {
      const root = JSON.parse(draft) as Record<string, unknown>;
      let parent: Record<string, unknown> = root;
      for (const key of path.slice(0, -1)) {
        const child = parent[key];
        if (!child || typeof child !== 'object' || Array.isArray(child)) return;
        parent = child as Record<string, unknown>;
      }
      const leaf = path.at(-1); if (!leaf) return;
      parent[leaf] = value;
      setDraft(json(root)); setPreview(null);
    } catch { onNotify('error', 'Correggi il JSON prima di usare i campi visuali.'); }
  };
  const parseDraft = () => { try { return JSON.parse(draft) as Record<string, unknown>; } catch { throw new Error('Il JSON contiene un errore di sintassi.'); } };
  const createPreview = async () => {
    if (!remote.data) return; setBusy(true); setPreview(null);
    try { const result = await api.request<{ preview: GuildSettings; currentVersion: number; changedSections: string[]; willApplyWithoutRestart: string[] }>(`${base}/settings/preview`, { method: 'POST', body: { settings: parseDraft() } }); setPreview(result); }
    catch (error) { onNotify('error', errorText(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!preview || !remote.data) { onNotify('error', 'Convalida prima le modifiche con l’anteprima.'); return; }
    setBusy(true);
    try {
      const result = await api.request<StoredSettings & { applicationStatus?: string; liveApply?: Array<{ feature: string; status: string }> }>(`${base}/settings`, { method: 'PATCH', body: { expectedVersion: preview.currentVersion, settings: preview.preview } });
      setPreview(null); setDraft(json(result.settings)); onChanged(result.applicationStatus === 'parziale' ? 'Impostazioni salvate; una o più applicazioni live richiedono attenzione.' : 'Impostazioni salvate e applicate.');
    } catch (error) { onNotify('error', errorText(error)); }
    finally { setBusy(false); }
  };
  const download = () => {
    const blob = new Blob([draft], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `impostazioni-${guild.id}.json`; a.click(); URL.revokeObjectURL(url);
  };
  return <>
    <PageHeader title="Impostazioni server" description="Modifica configurazione completa del bot, rivedi le sezioni interessate e salva con controllo versione." actions={<><button className="button" disabled={!remote.data} onClick={download}>Esporta JSON</button><button className="button primary" disabled={busy || !preview} onClick={() => void save()}>Conferma e salva</button></>} />
    <div className="grid two">
      <Panel title="Configurazione completa" subtitle={remote.data ? `Versione ${remote.data.version} · modificata ${date(remote.data.updatedAt)} da ${shortId(remote.data.updatedBy)}` : 'Caricamento'}>
        <RemoteState loading={remote.loading} error={remote.error} onRetry={remote.refresh} />
        {remote.data && <>
          {quick?.general && quick.messages && quick.modules && quick.retention && quick.tickets && <div className="quick-settings">
            <h4>Campi visuali più usati</h4>
            <div className="form-grid">
              <FormField label="Nome del bot"><input className="input" maxLength={80} value={quick.general.name} onChange={(event) => updateDraftValue(['general', 'name'], event.target.value)} /></FormField>
              <FormField label="Colore embed"><input className="input" type="color" value={quick.general.color} onChange={(event) => updateDraftValue(['general', 'color'], event.target.value)} /></FormField>
              <div className="span-2"><FormField label="Footer messaggi"><input className="input" maxLength={100} value={quick.general.footer} onChange={(event) => updateDraftValue(['general', 'footer'], event.target.value)} /></FormField></div>
              <div className="span-2"><FormField label="Titolo messaggio di benvenuto"><input className="input" maxLength={100} value={quick.messages.welcomeTitle} onChange={(event) => updateDraftValue(['messages', 'welcomeTitle'], event.target.value)} /></FormField></div>
              <div className="span-2"><FormField label="Testo di benvenuto"><textarea className="textarea" maxLength={1000} value={quick.messages.welcomeContent} onChange={(event) => updateDraftValue(['messages', 'welcomeContent'], event.target.value)} /></FormField></div>
              <div className="span-2"><FormField label="Titolo pannello ticket"><input className="input" maxLength={100} value={quick.messages.ticketPanelTitle} onChange={(event) => updateDraftValue(['messages', 'ticketPanelTitle'], event.target.value)} /></FormField></div>
              <div className="span-2"><FormField label="Descrizione pannello ticket"><textarea className="textarea" maxLength={2000} value={quick.messages.ticketPanelDescription} onChange={(event) => updateDraftValue(['messages', 'ticketPanelDescription'], event.target.value)} /></FormField></div>
              <FormField label="Ticket aperti massimi per utente"><input className="input" type="number" min={1} max={3} value={quick.tickets.maxOpenPerUser} onChange={(event) => updateDraftValue(['tickets', 'maxOpenPerUser'], Number(event.target.value))} /></FormField>
              <FormField label="Attesa tra nuovi ticket (secondi)"><input className="input" type="number" min={0} max={86400} value={quick.tickets.cooldownSeconds} onChange={(event) => updateDraftValue(['tickets', 'cooldownSeconds'], Number(event.target.value))} /></FormField>
              <FormField label="Conservazione dati (giorni)"><input className="input" type="number" min={1} max={3650} value={quick.retention.days} onChange={(event) => updateDraftValue(['retention', 'days'], Number(event.target.value))} /></FormField>
              <div className="span-2 checkbox-grid">
                <Check label="Modulo ticket" checked={quick.modules.tickets} onChange={(value) => updateDraftValue(['modules', 'tickets'], value)} />
                <Check label="Modulo segnalazioni" checked={quick.modules.reports} onChange={(value) => updateDraftValue(['modules', 'reports'], value)} />
                <Check label="Modulo moderazione" checked={quick.modules.moderation} onChange={(value) => updateDraftValue(['modules', 'moderation'], value)} />
                <Check label="Modulo sicurezza" checked={quick.modules.security} onChange={(value) => updateDraftValue(['modules', 'security'], value)} />
                <Check label="Modulo annunci" checked={quick.modules.announcements} onChange={(value) => updateDraftValue(['modules', 'announcements'], value)} />
                <Check label="Pulizia automatica dopo il periodo" checked={quick.retention.automaticCleanupEnabled} onChange={(value) => updateDraftValue(['retention', 'automaticCleanupEnabled'], value)} />
                <Check label="Ticket abilitati" checked={quick.tickets.enabled} onChange={(value) => updateDraftValue(['tickets', 'enabled'], value)} />
              </div>
            </div>
            <h4 className="mt-20">Configurazione completa</h4>
          </div>}
          <textarea className="textarea settings-editor" aria-label="Configurazione JSON" spellCheck={false} value={draft} onChange={(event) => { setDraft(event.target.value); setPreview(null); }} />
          <p className="help">Include testi, canali, ruoli, moduli, categorie ticket, moderazione, Anti-Raid, AutoMod e conservazione. L’API valida ID Discord e risorse prima di salvare.</p>
          <div className="form-actions"><button className="button" disabled={busy} onClick={() => { setDraft(json(remote.data?.settings)); setPreview(null); }}>Ripristina salvato</button><button className="button primary" disabled={busy || !draft.trim()} onClick={() => void createPreview()}>{busy ? 'Convalida…' : 'Convalida e mostra differenze'}</button></div>
        </>}
      </Panel>
      <div className="grid">
        <Panel title="Configurazione ticket" subtitle="Crea e gestisci i pannelli ticket dalla sezione Ticket, con categorie e canali creati dal bot.">
          <button className="button" onClick={() => onNavigate('tickets')}>Apri gestione pannelli ticket</button>
        </Panel>
        <Panel title="Anteprima modifiche" subtitle="Le modifiche non vengono salvate finché non confermi.">
          {!preview ? <Empty title="Nessuna anteprima" >Modifica il JSON e seleziona “Convalida e mostra differenze”.</Empty> : <>
            <Detail label="Versione rilevata" value={preview.currentVersion} />
            <Detail label="Sezioni modificate" value={preview.changedSections.length ? preview.changedSections.join(', ') : 'Nessuna modifica rilevata'} />
            <Detail label="Applicabili senza riavvio" value={preview.willApplyWithoutRestart.length ? preview.willApplyWithoutRestart.join(', ') : 'Nessuna'} />
            <div className="notice mt-14">La conferma applica i valori mostrati usando la versione {preview.currentVersion}. Se un altro operatore salva prima, l’API rifiuta l’aggiornamento.</div>
            <div className="form-actions"><button className="button primary" disabled={busy} onClick={() => void save()}>Conferma e salva</button></div>
          </>}
        </Panel>
        <Panel title="Cronologia modifiche" subtitle="Ultimi aggiornamenti di configurazione registrati.">
          <RemoteState loading={history.loading} error={history.error} onRetry={history.refresh} />
          {!history.loading && !history.error && !history.data?.changes.length && <Empty title="Nessuna modifica registrata" />}
          {history.data?.changes.map((record) => <ActivityItem key={record.id} record={record} />)}
        </Panel>
      </div>
    </div>
  </>;
}
