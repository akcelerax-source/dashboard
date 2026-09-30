// ==========================================================================
// NODEX ACE - Scenario Details & Recovery Cascade Assessment Modal
// ==========================================================================

import { state } from "../core/state.js";
import { SCENARIOS, ACE_TESTS } from "../data/scenarios.js";
import { ACE_TEST_CRITERIA } from "../core/ace-test-monitor.js";

export class ScenarioDetailsModal {
  /** ACE validation test: stimulus and the measured acceptance criteria. */
  static openAceTest(test, modalContainer) {
    const criteria = ACE_TEST_CRITERIA[test.code] || [];
    modalContainer.innerHTML = `
      <div class="modal-backdrop" id="scenario-modal-backdrop">
        <div class="modal-dialog scenario-details-dialog" role="dialog" aria-modal="true">
          <div class="modal-header">
            <div class="modal-title-wrap">
              <span class="scenario-code-badge">${test.code}</span>
              <h2 class="modal-title">${test.name}</h2>
            </div>
            <button class="modal-close-btn" id="btn-close-scenario-modal" aria-label="Close modal">&times;</button>
          </div>
          <div class="modal-body">
            <div class="scenario-meta-card">
              <div class="meta-row"><span class="meta-label">Test type:</span><span class="meta-val">ACE feature validation (NodeX Edge AI ACE decentralized only)</span></div>
              <div class="meta-row"><span class="meta-label">Stimulus:</span><span class="meta-val highlight-amber">${test.triggerCondition}</span></div>
              <div class="meta-row"><span class="meta-label">Recommended robots:</span><span class="meta-val">${test.robotCount}</span></div>
            </div>
            <div class="scenario-section">
              <h4 class="section-title">What is validated</h4>
              <p class="section-text">${test.description} ${test.purpose || ""}</p>
            </div>
            <div class="scenario-section">
              <h4 class="section-title">Acceptance criteria (measured on the live run)</h4>
              <ol class="section-text" style="margin: 4px 0 0 16px; padding: 0; line-height: 1.5;">
                ${criteria.map(c => `<li>${c}</li>`).join("")}
              </ol>
              <p class="section-text" style="margin-top: 6px; opacity: 0.8;">PASS when every criterion holds; FAIL when one does not; INCOMPLETE when the run ended before a criterion could be judged. Results appear in Analytics &amp; Efficiency (Test situation).</p>
            </div>
          </div>
        </div>
      </div>`;
    const close = () => { modalContainer.innerHTML = ""; };
    modalContainer.querySelector("#btn-close-scenario-modal")?.addEventListener("click", close);
    modalContainer.querySelector("#scenario-modal-backdrop")?.addEventListener("click", (e) => {
      if (e.target.id === "scenario-modal-backdrop") close();
    });
  }

  static open(scenarioCode = "S08") {
    const modalContainer = document.getElementById("modal-container");
    if (!modalContainer) return;

    const aceTest = ACE_TESTS.find(t => t.code === scenarioCode);
    if (aceTest) return ScenarioDetailsModal.openAceTest(aceTest, modalContainer);
    const scenario = SCENARIOS.find(s => s.code === scenarioCode) || SCENARIOS[7];

    modalContainer.innerHTML = `
      <div class="modal-backdrop" id="scenario-modal-backdrop">
        <div class="modal-dialog scenario-details-dialog" role="dialog" aria-modal="true">
          <!-- Header -->
          <div class="modal-header">
            <div class="modal-title-wrap">
              <span class="scenario-code-badge">${scenario.code}</span>
              <h2 class="modal-title">${scenario.name}</h2>
            </div>
            <button class="modal-close-btn" id="btn-close-scenario-modal" aria-label="Close modal">&times;</button>
          </div>

          <!-- Body -->
          <div class="modal-body">
            <!-- Scenario Overview Card -->
            <div class="scenario-meta-card">
              <div class="meta-row">
                <span class="meta-label">Scenario Code:</span>
                <span class="meta-val">${scenario.code} (${scenario.id})</span>
              </div>
              <div class="meta-row">
                <span class="meta-label">Fault Type:</span>
                <span class="meta-val highlight-amber">${scenario.fault}</span>
              </div>
              <div class="meta-row">
                <span class="meta-label">Nominal Duration:</span>
                <span class="meta-val">${scenario.duration} seconds</span>
              </div>
              <div class="meta-row">
                <span class="meta-label">Target Architecture:</span>
                <span class="meta-val highlight-blue">ACE Adaptive / Decentralized / Centralized</span>
              </div>
            </div>

            <div class="scenario-section">
              <h4 class="section-title">Scenario Description</h4>
              <p class="section-text">${scenario.description}</p>
            </div>

            <div class="scenario-section">
              <h4 class="section-title">Expected Behavior & Validation Target</h4>
              <p class="section-text">${scenario.expectedBehavior}</p>
            </div>

            <!-- Recovery-Cascade Impact Assessment Architecture (Section 21) -->
            <div class="recovery-cascade-container">
              <div class="cascade-header">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                  <path d="M2 17l10 5 10-5"></path>
                  <path d="M2 12l10 5 10-5"></path>
                </svg>
                <span>Recovery Impact Assessment Workflow (ACE Pipeline)</span>
              </div>

              <div class="cascade-flow">
                <!-- Step 1 -->
                <div class="cascade-step ${scenario.code === 'S08' ? 'active' : ''}">
                  <div class="step-num">1</div>
                  <div class="step-content">
                    <span class="step-title">Robot Failure</span>
                    <span class="step-desc">Target AMR stalls or suffers hardware fault (e.g. R11).</span>
                  </div>
                </div>
                <div class="cascade-arrow">&rarr;</div>

                <!-- Step 2 -->
                <div class="cascade-step">
                  <div class="step-num">2</div>
                  <div class="step-content">
                    <span class="step-title">Candidate Recovery Robots</span>
                    <span class="step-desc">Nearby available peers filtered by radius & battery.</span>
                  </div>
                </div>
                <div class="cascade-arrow">&rarr;</div>

                <!-- Step 3 -->
                <div class="cascade-step">
                  <div class="step-num">3</div>
                  <div class="step-content">
                    <span class="step-title">Recovery Impact Evaluation</span>
                    <span class="step-desc">Multi-factor cost equation evaluates secondary delays.</span>
                  </div>
                </div>
                <div class="cascade-arrow">&rarr;</div>

                <!-- Step 4 -->
                <div class="cascade-step">
                  <div class="step-num">4</div>
                  <div class="step-content">
                    <span class="step-title">Selected Recovery Robot</span>
                    <span class="step-desc">Optimal peer awarded task via distributed contract.</span>
                  </div>
                </div>
                <div class="cascade-arrow">&rarr;</div>

                <!-- Step 5 -->
                <div class="cascade-step">
                  <div class="step-num">5</div>
                  <div class="step-content">
                    <span class="step-title">Task Reassignment</span>
                    <span class="step-desc">Orphaned payload re-routed with zero central bottle-neck.</span>
                  </div>
                </div>
                <div class="cascade-arrow">&rarr;</div>

                <!-- Step 6 -->
                <div class="cascade-step">
                  <div class="step-num">6</div>
                  <div class="step-content">
                    <span class="step-title">Fleet Impact & Result</span>
                    <span class="step-desc">Zero cascade gridlock; 100% task throughput maintained.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer Actions -->
          <div class="modal-footer">
            <button class="btn-modal-secondary" id="btn-modal-cancel">Close</button>
            <button class="btn-modal-primary" id="btn-modal-apply-scenario">
              <span>Activate Scenario (${scenario.code})</span>
            </button>
          </div>
        </div>
      </div>
    `;

    // Event bindings
    const backdrop = document.getElementById("scenario-modal-backdrop");
    const closeBtn = document.getElementById("btn-close-scenario-modal");
    const cancelBtn = document.getElementById("btn-modal-cancel");
    const applyBtn = document.getElementById("btn-modal-apply-scenario");

    const close = () => {
      modalContainer.innerHTML = "";
    };

    closeBtn?.addEventListener("click", close);
    cancelBtn?.addEventListener("click", close);
    backdrop?.addEventListener("click", (e) => {
      if (e.target.id === "scenario-modal-backdrop") close();
    });

    applyBtn?.addEventListener("click", () => {
      state.set("selectedScenario", scenario.code);
      close();
    });
  }
}
