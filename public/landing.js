  const themeToggle = document.getElementById('themeToggle');
  const root = document.documentElement;
  themeToggle.addEventListener('click', () => {
    root.setAttribute('data-theme', root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  const techToggleRow = document.getElementById('techToggleRow');
  const techDrawer = document.querySelector('.tech-drawer');
  techToggleRow.addEventListener('click', () => {
    const open = techDrawer.getAttribute('data-open') === 'true';
    techDrawer.setAttribute('data-open', String(!open));
  });

  const menuToggle = document.querySelector('.menu-toggle');
  const navLinks = document.querySelector('.nav-links');
  menuToggle.addEventListener('click', () => {
    const isOpen = navLinks.style.display === 'flex';
    if(!isOpen){
      navLinks.style.cssText = 'display:flex;flex-direction:column;position:absolute;top:100%;left:0;right:0;background:var(--bg);padding:18px 32px;gap:14px;border-bottom:1px solid var(--border);';
    } else { navLinks.removeAttribute('style'); }
  });

  /* ---- live stats count-up ---- */
  function countUp(el, target, duration){
    const start = performance.now();
    function tick(now){
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(eased * target);
      if(p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  const statEls = document.querySelectorAll('.stat-num');
  const statsObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(entry.isIntersecting){
        statEls.forEach(el => countUp(el, parseInt(el.dataset.target, 10), 1400));
        statsObserver.disconnect();
      }
    });
  }, { threshold: 0.5 });
  if(statEls.length) statsObserver.observe(statEls[0]);
  setInterval(() => {
    const el = document.getElementById('stat1');
    if(el) el.textContent = parseInt(el.textContent || '0', 10) + 1;
  }, 9000);

  /* ---- code tabs ---- */
  document.querySelectorAll('.code-tabs').forEach(tabGroup => {
    const card = tabGroup.closest('.code-card');
    const copyBtn = card.querySelector('.copy-btn');
    tabGroup.querySelectorAll('.code-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        tabGroup.querySelectorAll('.code-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        card.querySelectorAll('pre').forEach(p => p.classList.remove('active'));
        const target = document.getElementById(tab.dataset.target);
        if(target) target.classList.add('active');
        if(copyBtn) copyBtn.dataset.copyTarget = tab.dataset.target;
      });
    });
  });

  /* ---- copy to clipboard ---- */
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if(!target) return;
      const text = target.innerText;
      const original = btn.innerHTML;
      const done = () => {
        btn.textContent = 'copiado ✓';
        setTimeout(() => { btn.innerHTML = original; }, 1600);
      };
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else {
        done();
      }
    });
  });

  /* ---- garantia pipeline simulation ---- */
  const simBtn = document.getElementById('simBtn');
  const simStage = document.getElementById('simStage');
  const pipelineRows = Array.from(document.querySelectorAll('#pipelineTrack .p-row'));
  const stageStatusMap = {
    aberta:'publicada', garantida:'valor travado', aceita:'confirmada',
    em_andamento:'em execução', entregue:'aguardando confirmação', 'concluída':'liberado + emitido'
  };
  let simRunning = false;
  function setPipelineUpTo(index){
    pipelineRows.forEach((row, i) => {
      row.classList.remove('active-now');
      const status = row.querySelector('.p-status');
      if(i < index){
        row.classList.add('done');
        status.textContent = stageStatusMap[row.dataset.stage];
      } else if(i === index){
        row.classList.add('done', 'active-now');
        status.textContent = stageStatusMap[row.dataset.stage];
      } else {
        row.classList.remove('done');
        status.textContent = 'aguardando';
      }
    });
    simStage.textContent = pipelineRows[index].dataset.stage;
  }
  if(simBtn){
    simBtn.addEventListener('click', () => {
      if(simRunning) return;
      simRunning = true;
      simBtn.disabled = true;
      simBtn.style.opacity = '0.6';
      let i = 0;
      setPipelineUpTo(0);
      const interval = setInterval(() => {
        i++;
        if(i >= pipelineRows.length){
          clearInterval(interval);
          setTimeout(() => {
            pipelineRows.forEach(r => r.classList.remove('active-now'));
            simRunning = false;
            simBtn.disabled = false;
            simBtn.style.opacity = '1';
          }, 700);
          return;
        }
        setPipelineUpTo(i);
      }, 850);
    });
  }

  /* ---- certificate verifier ---- */
  const verifyBtn = document.getElementById('verifyBtn');
  const verifyResult = document.getElementById('verifyResult');
  if(verifyBtn){
    verifyBtn.addEventListener('click', () => {
      const code = document.getElementById('verifyInput').value.trim() || '7xkq2m9frt';
      verifyResult.innerHTML = 'consultando indexador<span class="spin"></span>';
      verifyBtn.disabled = true;
      setTimeout(() => {
        verifyResult.innerHTML = `hash recalculado: <span class="ok">confere</span><br>dono confirmado (DAS API): <span class="ok">confere</span><br>código <b>${code}</b> — <span class="ok">verificado ✓</span>`;
        verifyBtn.disabled = false;
      }, 1100);
    });
  }

  /* ---- login mock ---- */
  const loginForm = document.getElementById('loginForm');
  const loginSuccess = document.getElementById('loginSuccess');
  const loginMsg = document.getElementById('loginMsg');
  const aMethodEl = document.getElementById('a-method');
  const methodLabels = { email:"'email'", google:"'google'", celular:"'celular'" };
  document.querySelectorAll('.login-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      const method = opt.dataset.method;
      if(aMethodEl) aMethodEl.textContent = methodLabels[method] || "'email'";
      loginForm.classList.add('hide');
      loginSuccess.classList.add('show');
      loginMsg.textContent = 'Conta criada em segundos. Já dá pra aceitar um trampo.';
      setTimeout(() => {
        loginForm.classList.remove('hide');
        loginSuccess.classList.remove('show');
      }, 2600);
    });
  });

  /* ---- portal spotlight ---- */
  document.querySelectorAll('.portal').forEach(portal => {
    portal.addEventListener('mousemove', (e) => {
      const rect = portal.getBoundingClientRect();
      portal.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      portal.style.setProperty('--my', `${e.clientY - rect.top}px`);
    });
  });
