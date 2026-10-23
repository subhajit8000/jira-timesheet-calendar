import { useEffect, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import { DateTime } from 'luxon';
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw, Download, ExternalLink, Clock3, AlertCircle, CircleCheck, Unplug, Plus, Pencil, Trash2 } from 'lucide-react';
import { formatHours, summarize, toCsv } from './report';
import LogWorkDialog from './LogWorkDialog';
import './App.css';

const views = [['dayGridMonth', 'Month'], ['dayGridWeek', 'Week'], ['listMonth', 'Agenda']];
const dateKey = date => DateTime.fromJSDate(date).toISODate();

function IconButton({ label, children, ...props }) {
  return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
}

export default function App() {
  const calendar = useRef(null);
  const dayPanel = useRef(null);
  const [view, setView] = useState('dayGridMonth');
  const [period, setPeriod] = useState(null);
  const [selectedDate, setSelectedDate] = useState(DateTime.local().toISODate());
  const [demo, setDemo] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState('');
  const [logForm, setLogForm] = useState(null);
  const [savedNotice, setSavedNotice] = useState('');
  const start = period?.start;
  const end = period?.end;

  useEffect(() => {
    if (!start || !end) return;
    const controller = new AbortController();
    async function load() {
      setPhase('loading');
      setReport(null);
      setError('');
      try {
        const statusResponse = await fetch('/api/status', { signal: controller.signal });
        if (!statusResponse.ok) throw new Error('The local server is unavailable.');
        const status = await statusResponse.json();
        if (!status.configured && !demo) {
          setPhase('unconfigured');
          return;
        }
        const query = new URLSearchParams({ start, end, demo: demo ? '1' : '0' });
        const response = await fetch(`/api/report?${query}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to load your work logs.');
        if (!controller.signal.aborted) {
          setReport(result);
          setPhase('ready');
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure.message);
          setPhase('error');
        }
      }
    }
    load();
    return () => controller.abort();
  }, [start, end, demo, refresh]);

  const entries = report?.entries || [];
  const totals = summarize(entries);
  const selectedEntries = entries.filter(entry => entry.date === selectedDate);
  const ready = phase === 'ready';
  const events = entries.map(entry => ({
    id: entry.id, title: `${entry.issueKey} ${formatHours(entry.seconds)}`,
    start: entry.date, allDay: true, extendedProps: entry,
  }));

  function selectDay(date, scroll = false) {
    setSelectedDate(date);
    if (scroll && window.matchMedia('(max-width: 1000px)').matches) {
      dayPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function openLogForm(date) {
    if (!ready || demo) return;
    selectDay(date);
    setLogForm({ date, timeZone: report.user.timeZone });
  }

  function openExistingLog(entry, action) {
    if (!ready || demo || !entry.version) return;
    setLogForm({ date: entry.date, timeZone: report.user.timeZone, entry, action });
  }

  function exportCsv() {
    const url = URL.createObjectURL(new Blob(['\uFEFF', toCsv(entries)], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${demo ? 'sample-' : ''}timesheet-${start}-${end}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-icon"><CalendarDays size={23} /></span><div><strong>My timesheet</strong><span>PARAGON AUTOMATION</span></div></div>
        <div className="account"><span className={`status-dot ${ready ? 'connected' : ''}`} />{report?.user.name || 'Local workspace'}</div>
      </header>

      <main>
        <div className="page-heading">
          <div><p className="eyebrow">WORK LOGS</p><h1>Time, accounted for.</h1></div>
          <div className="page-actions">
            <label className="sample-toggle"><input type="checkbox" checked={demo} onChange={event => setDemo(event.target.checked)} />Sample data</label>
            <IconButton label="Refresh work logs" onClick={() => setRefresh(value => value + 1)} disabled={phase === 'loading'}><RefreshCw size={18} className={phase === 'loading' ? 'spinning' : ''} /></IconButton>
            <IconButton label="Export CSV" onClick={exportCsv} disabled={!ready || !entries.length}><Download size={18} /></IconButton>
            <button className="primary-button log-work-button" disabled={!ready || demo} onClick={() => openLogForm(selectedDate)}><Plus size={17} />Log work</button>
          </div>
        </div>

        <div className={`connection-strip ${phase === 'error' ? 'error-strip' : ''}`} role="status">
          {phase === 'loading' ? <><RefreshCw size={16} className="spinning" />Loading work logs...</> :
            phase === 'unconfigured' ? <><Unplug size={17} />Jira not connected<span className="strip-secondary">Credentials pending</span></> :
            phase === 'error' ? <><AlertCircle size={17} />{error}</> :
            <><CircleCheck size={16} />{demo ? 'Sample data - not your Jira work logs' : 'Connected to Jira'}<span className="strip-secondary">{report.user.timeZone} / Updated {DateTime.fromISO(report.fetchedAt).toLocaleString(DateTime.TIME_SIMPLE)}</span></>}
        </div>

        {savedNotice && <p className="saved-notice" role="status">{savedNotice}</p>}
        <section className="metrics" aria-label="Period totals">
          <div><span>{view === 'dayGridWeek' ? 'WEEK TOTAL' : 'MONTH TOTAL'}</span><strong>{ready ? formatHours(totals.seconds) : '--'}</strong></div>
          <div><span>DAYS LOGGED</span><strong>{ready ? Object.keys(totals.days).length : '--'}</strong></div>
          <div><span>ISSUES</span><strong>{ready ? totals.issueCount : '--'}</strong></div>
          <div><span>DAILY AVERAGE <small>(logged days)</small></span><strong>{ready ? formatHours(totals.seconds / (Object.keys(totals.days).length || 1)) : '--'}</strong></div>
        </section>

        <div className="workspace">
          <section className="calendar-section" aria-label="Work log calendar" aria-busy={phase === 'loading'} onDoubleClick={event => {
            const cell = event.target.closest('.fc-daygrid-day[data-date]');
            if (cell && event.currentTarget.contains(cell)) openLogForm(cell.dataset.date);
          }}>
            <div className="calendar-toolbar">
              <div className="date-navigation">
                <IconButton label="Previous period" onClick={() => calendar.current?.getApi().prev()}><ChevronLeft size={19} /></IconButton>
                <IconButton label="Next period" onClick={() => calendar.current?.getApi().next()}><ChevronRight size={19} /></IconButton>
                <h2>{period?.title || 'Calendar'}</h2>
                <button className="today-button" onClick={() => calendar.current?.getApi().today()}>Today</button>
              </div>
              <div className="view-switch" role="group" aria-label="Calendar view">
                {views.map(([key, label]) => <button key={key} aria-pressed={view === key} onClick={() => calendar.current?.getApi().changeView(key)}>{label}</button>)}
              </div>
            </div>
            {ready && !entries.length && <div className="empty-period">No work logged in this period.</div>}
            <FullCalendar
              ref={calendar}
              plugins={[dayGridPlugin, listPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              headerToolbar={false}
              firstDay={1}
              fixedWeekCount={false}
              showNonCurrentDates={false}
              height="auto"
              dayMaxEvents={3}
              eventDisplay="block"
              events={events}
              displayEventTime={false}
              noEventsContent={phase === 'loading' ? 'Loading...' : ready ? 'No work logs' : 'No data available'}
              datesSet={({ view: current }) => {
                const nextStart = dateKey(current.currentStart);
                const nextEnd = dateKey(current.currentEnd);
                setPeriod({ start: nextStart, end: nextEnd, title: current.title });
                setView(current.type);
                setSelectedDate(previous => previous >= nextStart && previous < nextEnd ? previous : nextStart);
              }}
              dateClick={({ dateStr }) => selectDay(dateStr, true)}
              eventClick={({ event }) => selectDay(event.extendedProps.date, true)}
              eventDidMount={({ el, event }) => {
                el.setAttribute('title', `${event.extendedProps.issueKey}: ${event.extendedProps.summary} (${formatHours(event.extendedProps.seconds)})`);
                el.setAttribute('tabindex', '0');
              }}
              eventInteractive
              eventContent={({ event }) => <div className="log-event"><span>{event.extendedProps.issueKey}</span><b>{formatHours(event.extendedProps.seconds)}</b></div>}
              dayCellClassNames={({ date }) => dateKey(date) === selectedDate ? ['selected-day'] : []}
              dayCellContent={({ date, dayNumberText }) => {
                const key = dateKey(date);
                return <div className="day-heading"><button aria-label={`Show work logs for ${key}`} onClick={() => selectDay(key, true)}>{dayNumberText}</button><span>{totals.days[key] ? formatHours(totals.days[key]) : ''}</span></div>;
              }}
            />
            <footer className="calendar-footer"><span><i className="legend-dot" />Logged work</span><span>Monday-start weeks</span></footer>
          </section>

          <aside ref={dayPanel} className="day-panel" aria-label="Selected day">
            <div className="day-panel-heading"><span className="eyebrow">DAILY DETAIL</span><Clock3 size={18} /><h2>{DateTime.fromISO(selectedDate).toFormat('ccc, d LLL')}</h2><strong>{ready ? formatHours(totals.days[selectedDate] || 0) : '--'}</strong></div>
            <div className="day-entries">
              {!selectedEntries.length ? <p className="empty-day">{ready ? 'No work logged on this day.' : 'No work logs loaded.'}</p> : selectedEntries.map(entry => <article className="day-entry" key={entry.id}>
                <div className="entry-top">{entry.url ? <a href={entry.url} target="_blank" rel="noreferrer">{entry.issueKey}<ExternalLink size={13} /></a> : <span>{entry.issueKey}</span>}<b>{formatHours(entry.seconds)}</b></div>
                <h3>{entry.summary}</h3>
                <p>{entry.comment || 'No description'}</p>
                <time dateTime={entry.started}>{DateTime.fromISO(entry.started, { setZone: true }).toFormat('HH:mm')}</time>
                {!demo && <div className="entry-actions">
                  <IconButton label={`Edit work log for ${entry.issueKey}`} disabled={!ready || !entry.version} onClick={() => openExistingLog(entry, 'update')}><Pencil size={16} /></IconButton>
                  <IconButton label={`Delete work log for ${entry.issueKey}`} disabled={!ready || !entry.version} onClick={() => openExistingLog(entry, 'delete')}><Trash2 size={16} /></IconButton>
                </div>}
              </article>)}
            </div>
            <div className="week-totals"><h3>Weekly totals <small>(in period)</small></h3>
              {ready && Object.entries(totals.weeks).map(([week, seconds]) => <div className="week-total" key={week}><span>{DateTime.fromISO(week).toFormat('d LLL')} - {DateTime.fromISO(week).plus({ days: 6 }).toFormat('d LLL')}</span><b>{formatHours(seconds)}</b></div>)}
              {(!ready || !entries.length) && <span className="muted">No totals available</span>}
            </div>
          </aside>
        </div>
      </main>
      <footer className="app-footer"><span>Personal timesheet / Paragon Automation</span><span>{demo ? 'SAMPLE DATA' : 'LOCAL ONLY'}</span></footer>
      {logForm && <LogWorkDialog date={logForm.date} timeZone={logForm.timeZone} entry={logForm.entry} action={logForm.action} onClose={() => setLogForm(null)} onSaved={saved => {
        setSavedNotice(`${formatHours(saved.seconds)} ${saved.action === 'delete' ? 'deleted from' : saved.action === 'update' ? 'updated in' : 'saved to'} ${saved.issueKey} for ${saved.date}. Jira search may take a moment to update.`);
        setSelectedDate(saved.date);
        calendar.current?.getApi().gotoDate(saved.date);
        setRefresh(value => value + 1);
      }} />}
    </div>
  );
}
