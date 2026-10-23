import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, ExternalLink, RefreshCw, Trash2, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { editDuration, prepareWorklog, prepareWorklogUpdate } from '../shared/worklog';

export default function LogWorkDialog({ date, timeZone, entry, action = 'create', onClose, onSaved }) {
  const dialog = useRef(null);
  const inFlight = useRef(false);
  const csrfToken = useRef('');
  const [form, setForm] = useState(() => ({
    issueKey: entry?.issueKey || '', date,
    time: entry ? DateTime.fromISO(entry.started, { zone: timeZone }).toFormat('HH:mm') : '09:00',
    duration: entry ? editDuration(entry.seconds) : '', description: entry?.comment || '', replaceDescription: false,
  }));
  const [review, setReview] = useState(null);
  const [step, setStep] = useState('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const deleting = action === 'delete';
  const updating = action === 'update';
  const changing = deleting || updating;
  const actionTitle = deleting ? 'Delete work log' : updating ? 'Edit work log' : 'Log work';
  const successTitle = deleting ? 'Work log deleted' : updating ? 'Work log updated' : 'Work logged';

  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  function update(event) {
    setForm(previous => ({ ...previous, [event.target.name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
    setError('');
  }

  async function preview(event) {
    event.preventDefault();
    if (inFlight.current) return;
    setError('');
    try {
      if (updating) prepareWorklogUpdate(form, entry, timeZone);
      else if (!deleting) prepareWorklog(form, timeZone);
    } catch (failure) {
      setError(failure.message);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const statusResponse = await fetch('/api/status', { signal: AbortSignal.timeout(15000) });
      if (!statusResponse.ok) throw new Error('The local server is unavailable.');
      const status = await statusResponse.json();
      if (!status.configured) throw new Error('Configure Jira credentials before logging work.');
      csrfToken.current = status.csrfToken;
      const identity = changing ? { issueId: entry.issueId, worklogId: entry.worklogId, version: entry.version } : {};
      const payload = deleting ? { action, ...identity } : {
        ...form, action, ...identity,
        description: updating && !form.replaceDescription ? '' : form.description,
      };
      const response = await fetch('/api/worklogs/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken.current },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(120000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not review this work log.');
      setReview(result);
      setAcknowledged(false);
      setStep('review');
    } catch (failure) {
      setError(failure.name === 'TimeoutError' ? 'Review timed out. No change was submitted.' : failure.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function save() {
    if (inFlight.current || !acknowledged || step !== 'review') return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/worklogs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken.current },
        body: JSON.stringify({ reviewId: review.reviewId, action, confirmed: true, duplicateCheckAcknowledged: !changing && acknowledged }),
        signal: AbortSignal.timeout(120000),
      });
      const result = await response.json();
      if (!response.ok) {
        setStep('failed');
        setError(result.error || 'Change was not confirmed. Check Jira before trying again.');
        return;
      }
      setStep('saved');
      onSaved(result);
    } catch (failure) {
      setStep('failed');
      setError(`${failure.message} Check Jira's Work log before trying again; this action may have completed.`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="worklog-dialog" aria-labelledby="worklog-title" onCancel={event => {
      event.preventDefault();
      if (!inFlight.current) onClose();
    }}>
      <div className="dialog-heading">
        <h2 id="worklog-title">{step === 'edit' ? actionTitle : step === 'saved' ? successTitle : step === 'failed' ? 'Change not confirmed' : deleting ? 'Review deletion' : updating ? 'Review changes' : 'Review work log'}</h2>
        <button className="icon-button" aria-label="Close log work" title="Close" disabled={busy} onClick={onClose}><X size={18} /></button>
      </div>
      {error && <div className="form-error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
      {step === 'edit' ? <form onSubmit={preview}>
        {deleting ? <WorklogDetails review={{ ...entry, timeZone, description: entry.comment }} /> : <fieldset disabled={busy}>
          <label>Jira issue<input autoFocus={!updating} readOnly={updating} name="issueKey" value={form.issueKey} onChange={update} required maxLength={100} placeholder="FH-8864" autoComplete="off" /></label>
          <div className="form-row">
            <label>Date<input type="date" name="date" required value={form.date} onChange={update} /></label>
            <label>Start time<input type="time" name="time" required value={form.time} onChange={update} /></label>
          </div>
          <p className="field-detail">{timeZone}</p>
          <label>Duration<input name="duration" value={form.duration} onChange={update} required maxLength={30} placeholder="8h or 1h 30m" autoComplete="off" /></label>
          {updating && <label className="replace-description"><input type="checkbox" name="replaceDescription" checked={form.replaceDescription} onChange={update} />Replace description</label>}
          {updating && form.replaceDescription && <p className="field-detail">Replacing the description removes its existing rich-text formatting.</p>}
          <label>Description <span className="muted">({updating && !form.replaceDescription ? 'unchanged' : 'optional'})</span><textarea readOnly={updating && !form.replaceDescription} name="description" rows={3} maxLength={4000} value={form.description} onChange={update} /></label>
        </fieldset>}
        <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy && <RefreshCw size={16} className="spinning" />}{busy ? 'Checking Jira...' : deleting ? 'Review deletion' : 'Review'}</button></div>
      </form> : <>
        <WorklogDetails review={review} />
        {step === 'review' && <>
          {!changing && <div className="duplicate-warning"><AlertCircle size={17} /><div>
            {review.existingCount > 0 && <strong>{review.existingCount} existing {review.existingCount === 1 ? 'log' : 'logs'} for this issue and date: {editDuration(review.existingSeconds)}.</strong>}
            <p>Pending Jira Assistant entries are not visible here. Saving the same work in both places creates duplicate hours.</p>
          </div></div>}
          {deleting && <div className="duplicate-warning"><AlertCircle size={17} /><p>This permanently deletes the work log from Jira. There is no undo in this app.</p></div>}
          <label className="confirm-checkbox"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy} />{deleting ? 'I confirm permanent deletion of this work log.' : updating ? 'I reviewed these changes to my existing work log.' : 'I checked Jira and pending extension entries. This is additional work to log.'}</label>
          <div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => { setStep('edit'); setError(''); }}><ArrowLeft size={16} />Back</button><button className={deleting ? 'danger-button' : 'primary-button'} disabled={busy || !acknowledged} onClick={save}>{busy ? <RefreshCw size={16} className="spinning" /> : deleting ? <Trash2 size={16} /> : <Check size={16} />}{busy ? (deleting ? 'Deleting...' : 'Saving...') : deleting ? 'Delete from Jira' : updating ? 'Update in Jira' : 'Save to Jira'}</button></div>
        </>}
        {step === 'saved' && <p className="save-success" role="status"><Check size={18} />{successTitle}. Calendar refresh requested.</p>}
        {(step === 'saved' || step === 'failed') && <div className="dialog-actions"><a href={review.url} target="_blank" rel="noreferrer">Open issue in Jira <ExternalLink size={13} /></a><button className="primary-button" onClick={onClose}>Close</button></div>}
      </>}
    </dialog>
  );
}

function WorklogDetails({ review }) {
  const started = DateTime.fromISO(review.started, { zone: review.timeZone });
  return <dl className="review-details">
    <dt>Issue</dt><dd><a href={review.url} target="_blank" rel="noreferrer">{review.issueKey} <ExternalLink size={13} /></a><p>{review.summary}</p></dd>
    {review.accountName && <><dt>Account</dt><dd>{review.accountName}</dd></>}
    <dt>Date and time</dt><dd>{started.toFormat('yyyy-MM-dd HH:mm:ss.SSS ZZ')}<span>{review.timeZone}</span></dd>
    {review.action === 'update' && review.started !== review.original.started && <><dt>Previous start</dt><dd>{DateTime.fromISO(review.original.started, { zone: review.timeZone }).toFormat('yyyy-MM-dd HH:mm:ss.SSS ZZ')}</dd></>}
    <dt>Duration</dt><dd>{editDuration(review.seconds)}</dd>
    {review.action === 'update' && review.seconds !== review.original.seconds && <><dt>Previous duration</dt><dd>{editDuration(review.original.seconds)}</dd></>}
    <dt>Description{review.action === 'update' && !review.replaceDescription ? ' (unchanged)' : ''}</dt><dd className="review-description">{review.description || 'No description'}</dd>
    <dt>Remaining estimate</dt><dd>Unchanged</dd>
  </dl>;
}