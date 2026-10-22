// Snap & Identify — Mechanical AI : frontend logic
const $ = (id) => document.getElementById(id);
let selectedFile = null;

/* ---------- Image selection & preview ---------- */
function showMessage(text) { $('message').textContent = text; $('message').hidden = !text; }

function handleFile(file) {
  showMessage('');
  if (!file) return;
  // Validate that the chosen file is an image
  if (!file.type.startsWith('image/')) { showMessage('Please choose an image file.'); return; }
  selectedFile = file;
  if ($('preview').src) URL.revokeObjectURL($('preview').src);
  $('preview').src = URL.createObjectURL(file);   // instant preview
  $('previewBox').hidden = false;
  $('picker').hidden = true;
  $('result').hidden = true;
}

function clearImage() {
  selectedFile = null;
  $('cameraInput').value = ''; $('uploadInput').value = '';
  $('previewBox').hidden = true; $('picker').hidden = false;
  $('result').hidden = true; showMessage('');
  resetQuiz();
}

$('cameraInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
$('uploadInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
$('removeBtn').addEventListener('click', clearImage);

// Buttons open the hidden file inputs
$('uploadBtn').addEventListener('click', () => $('uploadInput').click());
$('cameraBtn').addEventListener('click', () => $('cameraInput').click());

// Drag & drop onto the upload zone (desktop)
const zone = $('picker');
['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
zone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
// Stop the browser from opening a file that is dropped outside the zone
['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));

/* ---------- Shrink the image (max 1280px, JPEG) before uploading ---------- */
async function shrinkImage(file, maxSide = 1280) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch (e) { return file; } // if the browser can't resize, send the original
}

/* ---------- Call the backend ---------- */
$('identifyBtn').addEventListener('click', async () => {
  showMessage('');
  if (!selectedFile) { showMessage('Please select or capture an image first.'); return; }

  $('loading').hidden = false; $('identifyBtn').disabled = true; $('result').hidden = true;
  try {
    // Shrink big phone photos first: much faster upload and analysis
    const small = await shrinkImage(selectedFile);
    const form = new FormData();
    form.append('image', small, 'photo.jpg');
    // Give up (and show an error) if nothing comes back within 90 seconds
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 90000);
    const res = await fetch('/api/identify', { method: 'POST', body: form, signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error((data && data.error) || 'failed');
    renderResult(data);
  } catch (err) {
    if (err.name === 'AbortError') showMessage('Analysis is taking too long. Please try again.');
    else showMessage(err.message && err.message !== 'failed' && err.message !== 'Failed to fetch'
      ? err.message : 'Analysis failed. Please try again.');
  } finally {
    $('loading').hidden = true; $('identifyBtn').disabled = false;
  }
});

/* ---------- Show the result (textContent only: safe against HTML injection) ---------- */
function renderResult(d) {
  $('rName').textContent = d.component_name;
  $('rConf').textContent = d.confidence + ' confidence';
  $('rConf').className = 'badge ' + d.confidence;
  $('rFunction').textContent = d.function;
  $('rApps').textContent = d.applications;
  $('rFeatures').textContent = d.visible_features;
  $('rQuality').textContent = d.image_quality_note;
  const unclear = d.confidence === 'Low' || /unable to identify/i.test(d.component_name);
  $('unclear').hidden = !unclear;
  $('result').hidden = false;
  $('result').scrollIntoView({ behavior: 'smooth' });
  // Build a quiz about the identified component (or reset to the general quiz if unclear)
  if (unclear) resetQuiz(); else loadQuiz(d);
}

/* ---------- Quiz: always generated from the information shown for the identified component ---------- */
let QUESTIONS = [];
let submitted = false;
let lastInfo = null;
let quizToken = 0; // ignores late quiz responses if the user analyzes another image

function buildQuiz() {
  submitted = false;
  $('score').hidden = true;
  $('retryQuiz').hidden = true;
  $('submitQuiz').textContent = 'Submit Answers';
  $('submitQuiz').hidden = QUESTIONS.length === 0;
  $('quiz').innerHTML = '';
  QUESTIONS.forEach((item, i) => {
    const box = document.createElement('div'); box.className = 'q';
    const p = document.createElement('p'); p.textContent = `${i + 1}. ${item.q}`; box.appendChild(p);
    item.options.forEach((opt, k) => {
      const label = document.createElement('label'); label.className = 'opt';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'q' + i; radio.value = k;
      label.append(radio, document.createTextNode(opt)); box.appendChild(label);
    });
    const ex = document.createElement('p'); ex.className = 'expl'; ex.hidden = true; ex.id = 'ex' + i;
    box.appendChild(ex); $('quiz').appendChild(box);
  });
}

// No quiz yet: wait for an identified component
function resetQuiz() {
  quizToken++;
  QUESTIONS = [];
  $('h-quiz').textContent = 'Test Your Knowledge';
  $('quizStatus').textContent = 'Identify a component first. A quiz made from its information will appear here.';
  $('quizStatus').hidden = false;
  buildQuiz();
}

// Ask the backend (Gemini) for 3 questions based on the identified component's information
async function loadQuiz(info) {
  lastInfo = info;
  const token = ++quizToken;
  QUESTIONS = []; buildQuiz();
  $('h-quiz').textContent = 'Test Your Knowledge';
  $('quizStatus').textContent = '⏳ Creating a quiz from this information…';
  $('quizStatus').hidden = false;
  try {
    const res = await fetch('/api/quiz', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
      body: JSON.stringify({
        component_name: info.component_name, function: info.function,
        applications: info.applications, visible_features: info.visible_features,
      }),
    });
    const data = await res.json();
    if (token !== quizToken) return;
    if (!res.ok || !Array.isArray(data.questions)) throw new Error('quiz failed');
    QUESTIONS = data.questions.map((x) => ({ q: x.question, options: x.options, answer: x.answer_index, why: x.explanation }));
    $('h-quiz').textContent = 'Test Your Knowledge: ' + info.component_name;
    $('quizStatus').textContent = 'Quiz created from the information above.';
    buildQuiz();
  } catch (e) {
    if (token !== quizToken) return;
    $('quizStatus').textContent = 'Could not create the quiz right now.';
    $('retryQuiz').hidden = false;
  }
}

$('retryQuiz').addEventListener('click', () => { if (lastInfo) loadQuiz(lastInfo); });

// Submit grades the answers; the button then becomes "Retake quiz"
$('submitQuiz').addEventListener('click', () => {
  if (submitted) { buildQuiz(); return; }
  let score = 0, unanswered = 0;
  QUESTIONS.forEach((item, i) => {
    const picked = document.querySelector(`input[name="q${i}"]:checked`);
    if (!picked) unanswered++;
    document.querySelectorAll(`input[name="q${i}"]`).forEach((r, k) => {
      r.disabled = true;
      r.parentElement.classList.remove('correct', 'wrong');
      if (k === item.answer) r.parentElement.classList.add('correct');
      else if (r.checked) r.parentElement.classList.add('wrong');
    });
    if (picked && Number(picked.value) === item.answer) score++;
    const ex = $('ex' + i); ex.textContent = '✔ ' + item.why; ex.hidden = false;
  });
  $('score').textContent = `You scored ${score}/${QUESTIONS.length}` + (unanswered ? ` (${unanswered} unanswered)` : '');
  $('score').hidden = false;
  $('submitQuiz').textContent = 'Retake quiz';
  submitted = true;
});

resetQuiz();
