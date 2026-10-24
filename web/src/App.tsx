import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api.js';
import { DashboardPage } from './pages.js';
import type { DiscordUser, GuildChoice } from './types.js';

type PageKey = 'overview' | 'tickets' | 'reports' | 'moderation' | 'security' | 'announcements' | 'resources' | 'activity' | 'settings';
type Stage = 'checking' | 'setup' | 'signed-out' | 'servers' | 'dashboard';
interface Health { status: string; oauthEnabled: boolean; botReady: boolean; }

const navigation: Array<{ key: PageKey; label: string; icon: string; section: string }> = [
  { key: 'overview', label: 'Panoramica', icon: '◈', section: 'Gestione' },
  { key: 'tickets', label: 'Ticket', icon: '▤', section: 'Gestione' },
  { key: 'reports', label: 'Segnalazioni', icon: '⚑', section: 'Gestione' },
  { key: 'moderation', label: 'Moderazione', icon: '⚔', section: 'Gestione' },
  { key: 'security', label: 'Sicurezza', icon: '⬡', section: 'Server' },
  { key: 'announcements', label: 'Annunci', icon: '◉', section: 'Server' },
  { key: 'resources', label: 'Ruoli e canali', icon: '▦', section: 'Server' },
  { key: 'activity', label: 'Registro attività', icon: '◷', section: 'Sistema' },
  { key: 'settings', label: 'Impostazioni', icon: '⚙', section: 'Sistema' },
];

const titles: Record<PageKey, { title: string; subtitle: string }> = {
  overview: { title: 'Panoramica', subtitle: 'Stato reale del bot e attività del server.' },
  tickets: { title: 'Ticket', subtitle: 'Assistenza privata, accessibile agli operatori autorizzati.' },
  reports: { title: 'Segnalazioni', subtitle: 'Esamina le segnalazioni secondo i ruoli assegnati.' },
  moderation: { title: 'Moderazione', subtitle: 'Azioni registrate con verifica di permessi e gerarchie.' },
  security: { title: 'Sicurezza', subtitle: 'Controlli automatici, lockdown e diagnosi.' },
  announcements: { title: 'Annunci e avvisi', subtitle: 'Anteprima, pubblicazione e programmazione.' },
  resources: { title: 'Ruoli e canali', subtitle: 'Scegli risorse effettive del server Discord.' },
  activity: { title: 'Registro attività', subtitle: 'Modifiche e operazioni registrate dal backend.' },
  settings: { title: 'Impostazioni', subtitle: 'Configura il bot dal sito senza comandi di setup.' },
};

export default function App() {
  const [stage, setStage] = useState<Stage>('checking');
  const [health, setHealth] = useState<Health | null>(null);
  const [user, setUser] = useState<DiscordUser | null>(null);
  const [guilds, setGuilds] = useState<GuildChoice[]>([]);
  const [guild, setGuild] = useState<GuildChoice | null>(null);
  const [page, setPage] = useState<PageKey>('overview');
  const [mobileNav, setMobileNav] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [reloadSequence, setReloadSequence] = useState(0);
  const [bootError, setBootError] = useState('');

  const bootstrap = useCallback(async () => {
    setStage('checking');
    try {
      const healthResponse = await fetch('/health', { credentials: 'include' });
      if (!healthResponse.ok) throw new Error('Il backend non risponde correttamente.');
      const currentHealth = await healthResponse.json() as Health;
      setHealth(currentHealth);
      if (!currentHealth.oauthEnabled) { setStage('setup'); return; }
      const me = await api.request<{ user: DiscordUser; csrfToken: string }>('/auth/me');
      api.setCsrfToken(me.csrfToken);
      setUser(me.user);
      const result = await api.request<{ guilds: GuildChoice[] }>('/guilds');
      setGuilds(result.guilds);
      setStage('servers');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { setStage('signed-out'); return; }
      setBootError(error instanceof Error ? error.message : 'Errore durante il collegamento al backend.');
      setStage('signed-out');
    }
  }, []);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  const notify = useCallback((kind: 'success' | 'error', text: string) => {
    setMessage({ kind, text });
    window.setTimeout(() => setMessage((current) => current?.text === text ? null : current), 5500);
  }, []);

  const changed = useCallback((text = 'Modifica completata.') => {
    setReloadSequence((value) => value + 1);
    notify('success', text);
  }, [notify]);

  const logout = useCallback(async () => {
    try { await api.request('/auth/logout', { method: 'POST' }); }
    catch { /* La sessione locale viene comunque rimossa dalla vista. */ }
    api.setCsrfToken('');
    setUser(null);
    setGuild(null);
    setStage('signed-out');
  }, []);

  const pageTitle = titles[page];
  const groupedNavigation = useMemo(() => [...new Set(navigation.map((item) => item.section))], []);

  if (stage === 'checking') return <LoadingScreen />;
  if (stage === 'setup') return <SetupScreen botReady={health?.botReady ?? false} />;
  if (stage === 'signed-out') return <LoginScreen error={bootError} oauthEnabled={health?.oauthEnabled ?? false} onRetry={() => void bootstrap()} />;
  if (stage === 'servers') return <ServerPicker servers={guilds} user={user} botReady={health?.botReady ?? false} onSelect={(server) => { setGuild(server); setPage('overview'); setStage('dashboard'); }} onLogout={() => void logout()} />;
  if (!guild) return <ServerPicker servers={guilds} user={user} botReady={health?.botReady ?? false} onSelect={(server) => { setGuild(server); setStage('dashboard'); }} onLogout={() => void logout()} />;

  return (
    <div className="app-shell">
      <div className={`mobile-overlay ${mobileNav ? 'show' : ''}`} onClick={() => setMobileNav(false)} />
      <div className="shell">
        <aside className={`sidebar ${mobileNav ? 'open' : ''}`} aria-label="Navigazione principale">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">LP</div>
            <div className="brand-copy"><strong>The Last Pact<br />Guardian</strong><span>Gestione</span></div>
          </div>
          {groupedNavigation.map((section) => (
            <div key={section}>
              <div className="nav-label">{section}</div>
              <nav className="nav-list">
                {navigation.filter((item) => item.section === section).map((item) => (
                  <button key={item.key} className={`nav-item ${page === item.key ? 'active' : ''}`} onClick={() => { setPage(item.key); setMobileNav(false); }}>
                    <span className="nav-icon" aria-hidden="true">{item.icon}</span>{item.label}
                  </button>
                ))}
              </nav>
            </div>
          ))}
          <div className="sidebar-bottom">
            <p>Le azioni rispettano i permessi Discord correnti e i ruoli configurati.</p>
            <button className="button ghost small" onClick={() => { setGuild(null); setStage('servers'); }}>⇄ Cambia server</button>
            <button className="button ghost small" onClick={() => void logout()}>↪ Esci da Discord</button>
          </div>
        </aside>

        <main className="main-column">
          <header className="topbar">
            <div className="topbar-left">
              <button className="icon-button mobile-menu" aria-label="Apri menu" onClick={() => setMobileNav(true)}>☰</button>
              <div>
                <h1>{pageTitle.title}</h1>
                <div className="topbar-sub">{pageTitle.subtitle}</div>
              </div>
            </div>
            <div className="topbar-actions">
              <select className="guild-select" aria-label="Server selezionato" value={guild.id} onChange={(event) => {
                const selected = guilds.find((item) => item.id === event.target.value);
                if (selected) { setGuild(selected); setReloadSequence((value) => value + 1); }
              }}>
                {guilds.filter((item) => item.botStatus === 'presente').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <div className="user-chip"><span className="avatar">{(user?.global_name ?? user?.username ?? '?').slice(0, 1).toUpperCase()}</span><span className="user-name">{user?.global_name ?? user?.username}</span></div>
            </div>
          </header>
          <section className="content">
            {message && <div className={message.kind === 'error' ? 'alert' : 'success'} role="status">{message.text}</div>}
            {guild.botStatus !== 'presente' && <div className="alert">Il bot risulta offline o non disponibile per questo server. Le pagine mostreranno gli errori reali restituiti dal backend.</div>}
            <DashboardPage key={`${guild.id}:${page}`} page={page} guild={guild} guilds={guilds}
              onSelectGuild={(selected) => { setGuild(selected); setReloadSequence((value) => value + 1); }}
              onNotify={notify} onChanged={changed} reloadSequence={reloadSequence} onNavigate={setPage} />
          </section>
        </main>
      </div>
    </div>
  );
}

function LoadingScreen() {
  return <div className="login-screen"><div className="login-card"><div className="brand-mark">LP</div><div className="spinner" /><p className="mt-16">Collegamento al backend…</p></div></div>;
}

function SetupScreen({ botReady }: { botReady: boolean }) {
  return <div className="login-screen"><div className="login-card">
    <div className="brand-mark">LP</div><p className="eyebrow">Configurazione necessaria</p><h1>Prepara il collegamento Discord</h1>
    <p>Il backend non ha ancora credenziali OAuth2 complete. Le pagine amministrative restano chiuse finché non configuri l’app Discord.</p>
    <div className="notice">Inserisci <code>DISCORD_CLIENT_ID</code>, <code>DISCORD_CLIENT_SECRET</code>, <code>SESSION_SECRET</code> e <code>OAUTH_TOKEN_ENCRYPTION_KEY</code> nel file locale <code>.env</code>, registra il callback OAuth2 e riavvia il backend.</div>
    <p className="login-note">Bot Discord: {botReady ? 'connesso' : 'non connesso'}. Le credenziali non vengono richieste né salvate da questa pagina.</p>
  </div></div>;
}

function LoginScreen({ error, oauthEnabled, onRetry }: { error: string; oauthEnabled: boolean; onRetry: () => void }) {
  return <div className="login-screen"><div className="login-card">
    <div className="brand-mark">LP</div><p className="eyebrow">Gestione community</p><h1>The Last Pact Guardian</h1>
    <p>Pannello di gestione del server Discord. L’accesso usa Discord OAuth2; il token del bot resta sul backend.</p>
    {error && <div className="alert">{error}</div>}
    {oauthEnabled ? <a className="button primary" href="/api/v1/auth/discord">◈ Accedi con Discord</a> : <button className="button" onClick={onRetry}>Riprova collegamento</button>}
    <p className="login-note">Non è un sito ufficiale di Roblox o di The Last Pact.</p>
  </div></div>;
}

function ServerPicker({ servers, user, botReady, onSelect, onLogout }: { servers: GuildChoice[]; user: DiscordUser | null; botReady: boolean; onSelect: (server: GuildChoice) => void; onLogout: () => void }) {
  return <div className="login-screen"><div className="login-card server-picker">
    <div className="brand-mark">LP</div><p className="eyebrow">Sessione Discord valida</p><h1>Scegli il server</h1>
    <p>Accesso come <strong>{user?.global_name ?? user?.username}</strong>. Sono mostrati i server in cui sei proprietario o hai Gestisci server o Gestisci canali.</p>
    {!servers.length ? <div className="empty"><div><strong>Nessun server configurabile</strong>Verifica il tuo accesso Discord e che il bot sia online.</div></div> : <div className="server-list">
      {servers.map((server) => <div className="server-card" key={server.id}>
        <div className="server-avatar">{server.icon ? <img src={`https://cdn.discordapp.com/icons/${server.id}/${server.icon}.png?size=64`} alt="" /> : server.name.slice(0, 1)}</div>
        <div className="server-info"><strong>{server.name}</strong><span>{server.owner ? 'Proprietario' : server.canManageGuild ? 'Gestisci server' : 'Gestisci canali'}</span></div>
        {server.botStatus === 'presente' ? <button className="button primary small" onClick={() => onSelect(server)}>Apri pannello</button>
          : server.botStatus === 'assente' && server.inviteUrl ? <a className="button small" href={server.inviteUrl} target="_blank" rel="noopener noreferrer">Invita bot ↗</a>
            : <span className="status-pill status-warn">Bot offline</span>}
      </div>)}
    </div>}
    {!botReady && <div className="notice">Il backend non rileva il bot connesso. Le operazioni Discord non saranno disponibili fino al suo avvio.</div>}
    <button className="button ghost small" onClick={onLogout}>Esci da Discord</button>
  </div></div>;
}
