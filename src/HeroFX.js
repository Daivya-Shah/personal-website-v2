import * as THREE from 'three';

export class HeroFX {
	constructor(containerEl) {
		this.containerEl = containerEl;
		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
		this.camera.position.z = 70;
		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
		// Retina phones often use DPR 3; capping at 2 made hero sprites look soft on iOS/Safari
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
		this.containerEl.appendChild(this.renderer.domElement);
		this.renderer.domElement.style.willChange = 'transform';

		this.clock = new THREE.Clock();
		this.mouse = new THREE.Vector2();
		this.group = new THREE.Group();
		this.scene.add(this.group);
		
		this.explodeState = null; // null | { phase: 'explode' | 'bounce' | 'return', startTime: number }
		this.explodedVelocities = [];
		this.originalPositions = [];
		this.returnProgress = 0;
		this.spriteBounceCounts = [];
		this.lastVelocitySigns = []; // track velocity signs to detect actual bounces
		this.hammerCanvas = null; // cache hammer cursor canvas
		this.hammerRotation = 0; // current hammer rotation angle
		this.hammerAnimation = null; // null | { startTime: number, startRotation: number }

		// Reusable objects to avoid per-frame/per-event allocations
		this._mouseWorld = new THREE.Vector3();
		this._hoverCursorCache = { rotation: null, url: null };
		this._lastCursorStyle = 'default';
		this._isHovering = false;
		this._isPortrait = false;

		// Rasterize SVGs at high resolution: Simple Icons decode tiny (~24px) by default;
		// sampling that up for THREE.Sprites is very blurry on iOS Safari WebGL.
		this._configureSpriteTexture = (tex) => {
			tex.generateMipmaps = false;
			tex.minFilter = THREE.LinearFilter;
			tex.magFilter = THREE.LinearFilter;
			tex.wrapS = THREE.ClampToEdgeWrapping;
			tex.wrapT = THREE.ClampToEdgeWrapping;
			tex.colorSpace = THREE.SRGBColorSpace;
			tex.needsUpdate = true;
			return tex;
		};

		this._loadSvgTexture = async (url) => {
			const basePx = 256;
			try {
				const res = await fetch(url, { mode: 'cors' });
				if (!res.ok) throw new Error('HTTP ' + res.status);
				let svgText = await res.text();
				if (/<svg[^>]*\swidth=/i.test(svgText)) {
					svgText = svgText
						.replace(/\swidth="[^"]*"/i, ` width="${basePx}"`)
						.replace(/\sheight="[^"]*"/i, ` height="${basePx}"`);
				} else {
					svgText = svgText.replace(/<svg\b/i, `<svg width="${basePx}" height="${basePx}" `);
				}

				const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
				const img = await new Promise((resolve, reject) => {
					const el = new Image();
					el.crossOrigin = 'anonymous';
					el.onload = () => resolve(el);
					el.onerror = () => reject(new Error('svg image load'));
					el.src = dataUrl;
				});

				const pr = Math.min(window.devicePixelRatio || 1, 3);
				const canvas = document.createElement('canvas');
				canvas.width = Math.round(basePx * pr);
				canvas.height = Math.round(basePx * pr);
				const ctx = canvas.getContext('2d', { alpha: true });
				if (!ctx) return null;
				ctx.imageSmoothingEnabled = true;
				if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
				ctx.setTransform(pr, 0, 0, pr, 0, 0);
				ctx.clearRect(0, 0, basePx, basePx);
				ctx.drawImage(img, 0, 0, basePx, basePx);

				const tex = this._configureSpriteTexture(new THREE.CanvasTexture(canvas));
				return tex;
			} catch (e) {
				return null;
			}
		};

		this._initLogos();
		this._onResize();
		window.addEventListener('resize', this._onResize);
		window.addEventListener('mousemove', this._onMouseMove);
		this.renderer.domElement.addEventListener('click', this._onClick);
		this.renderer.domElement.style.pointerEvents = 'auto';
		this._animate();
	}

	dispose = () => {
		cancelAnimationFrame(this._raf);
		window.removeEventListener('resize', this._onResize);
		window.removeEventListener('mousemove', this._onMouseMove);
		this.renderer.domElement.removeEventListener('click', this._onClick);
		this.renderer.dispose();
		if (this.containerEl && this.renderer.domElement.parentNode === this.containerEl) {
			this.containerEl.removeChild(this.renderer.domElement);
		}
	};

	_initParticles() {
		const particleCount = 800;
		const geometry = new THREE.BufferGeometry();
		const positions = new Float32Array(particleCount * 3);
		const colors = new Float32Array(particleCount * 3);

		const color = new THREE.Color();
		for (let i = 0; i < particleCount; i++) {
			positions[i * 3 + 0] = (Math.random() - 0.5) * 200;
			positions[i * 3 + 1] = (Math.random() - 0.5) * 120;
			positions[i * 3 + 2] = (Math.random() - 0.5) * 200;

			// teal to cyan gradient
			color.setHSL(0.48 + Math.random() * 0.06, 0.7, 0.55);
			colors[i * 3 + 0] = color.r;
			colors[i * 3 + 1] = color.g;
			colors[i * 3 + 2] = color.b;
		}

		geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

		const material = new THREE.PointsMaterial({
			size: 1.8,
			sizeAttenuation: true,
			vertexColors: true,
			transparent: true,
			opacity: 0.85,
		});

		this.points = new THREE.Points(geometry, material);
		this.scene.add(this.points);
	}

	_onResize = () => {
		const { clientWidth, clientHeight } = this.containerEl;
		this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(clientWidth, clientHeight, false);

		// compute bounds for horizontal scaling
		const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * this.camera.position.z;
		const halfW = halfH * this.camera.aspect;
		const isPortrait = clientWidth < clientHeight;

		// On portrait containers (mobile) the same world-unit scale maps to more pixels
		// because the canvas is taller. Scale sprites and their label gap proportionally.
		const spriteScale = 8 * Math.min(1, clientWidth / Math.max(1, clientHeight));

		// Use tighter margins on mobile so the orbit radius is larger relative to the screen
		const safety = isPortrait ? 1 : 4;
		const spriteHalf = isPortrait ? spriteScale / 2 : 3.25;
		let maxPlannedRadius = 1;
		for (const s of this.toolSprites || []) maxPlannedRadius = Math.max(maxPlannedRadius, (s.userData && s.userData.radius) || 0);
		const maxAllowedX = Math.max(1, halfW - safety - spriteHalf);
		this.xScale = Math.min(1.5, maxAllowedX / Math.max(1, maxPlannedRadius));
		this._isPortrait = isPortrait;

		const ratio = spriteScale / 8;
		const yGap = spriteScale * 0.475; // 3.8/8 — keeps label flush under icon at any size
		for (const s of this.toolSprites || []) {
			s.scale.set(spriteScale, spriteScale, 1);
			if (s.userData.label) {
				const lbl = s.userData.label;
				const newLabelH = (lbl.userData.baseH || 2.2) * ratio;
				lbl.scale.set(newLabelH * (lbl.userData.aspect || 1), newLabelH, 1);
				lbl.userData.yGap = yGap;
			}
		}

		if (isPortrait) this._initFloatPositions();
	};

	_initFloatPositions = () => {
		if (!this.toolSprites || this.toolSprites.length === 0) return;
		const { clientWidth, clientHeight } = this.containerEl;
		const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * this.camera.position.z;
		const halfW = halfH * (clientWidth / Math.max(clientHeight, 1));
		const xRange = halfW * 0.80;

		// Keep icons out of the center text area (h2 + tagline + buttons ≈ ±10 world units)
		const textClear = 10;
		const yEdge    = halfH * 0.68; // don't go all the way to the very top/bottom edge
		const zoneH    = yEdge - textClear; // height of each zone in world units

		const n        = this.toolSprites.length;
		const topCount = Math.ceil(n / 2);
		const botCount = n - topCount;

		this.toolSprites.forEach((s, i) => {
			const inTop    = i < topCount;
			const localI   = inTop ? i : i - topCount;
			const localN   = inTop ? topCount : botCount;
			const cols     = Math.max(2, Math.ceil(Math.sqrt(localN * (clientWidth / Math.max(clientHeight * 0.35, 1)))));
			const rows     = Math.ceil(localN / cols);
			const cellW    = (2 * xRange) / cols;
			const cellH    = zoneH / Math.max(rows, 1);
			const col      = localI % cols;
			const row      = Math.floor(localI / cols);
			// Deterministic jitter — stable across repeated calls as sprites load
			const jx       = Math.sin(i * 127.1 + 311.7) * cellW * 0.25;
			const jy       = Math.sin(i * 269.5 + 183.3) * cellH * 0.25;
			s.userData.floatX = -xRange + (col + 0.5) * cellW + jx;
			s.userData.floatY = inTop
				? (yEdge  - (row + 0.5) * cellH) + jy   // top zone
				: (-textClear - (row + 0.5) * cellH) + jy; // bottom zone

			// Drift params set once — small amp so icons stay within their zone
			if (s.userData.floatFreqX === undefined) {
				s.userData.floatFreqX  = 0.12 + Math.abs(Math.sin(i * 43.7)) * 0.18;
				s.userData.floatFreqY  = 0.12 + Math.abs(Math.sin(i * 61.3)) * 0.18;
				s.userData.floatPhaseX = (i * 137.508) % (Math.PI * 2);
				s.userData.floatPhaseY = (i * 222.492) % (Math.PI * 2);
				s.userData.floatAmpX   = 0.8 + Math.abs(Math.sin(i * 79.3)) * 1.2;
				s.userData.floatAmpY   = 0.6 + Math.abs(Math.sin(i * 53.7)) * 0.9; // tighter in y
			}
		});
	};

	_getHammerCursor = (rotation = 0) => {
		// Round to 3 decimal places so near-identical frames share the cache
		const key = Math.round(rotation * 1000) / 1000;
		if (this._hoverCursorCache.rotation === key) return this._hoverCursorCache.url;

		if (!this.hammerCanvas) {
			this.hammerCanvas = document.createElement('canvas');
			this.hammerCanvas.width = 128;
			this.hammerCanvas.height = 128;
		}
		const canvas = this.hammerCanvas;
		const ctx = canvas.getContext('2d');
		ctx.clearRect(0, 0, 128, 128);
		ctx.save();
		ctx.translate(64, 64);
		ctx.rotate(key);
		ctx.font = '96px Arial';
		ctx.fillText('🔨', -48, 32);
		ctx.restore();

		const url = canvas.toDataURL();
		this._hoverCursorCache.rotation = key;
		this._hoverCursorCache.url = url;
		return url;
	};

	_onMouseMove = (e) => {
		const rect = this.containerEl.getBoundingClientRect();
		this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

		// Update hover flag — cursor is applied inside _animate to stay off the mouse-event path
		if (!this.explodeState && this.toolSprites) {
			this._mouseWorld.set(this.mouse.x * 50, this.mouse.y * 40, 0);
			let hovering = false;
			for (const sprite of this.toolSprites) {
				if (sprite.position.distanceTo(this._mouseWorld) < 15) { hovering = true; break; }
			}
			this._isHovering = hovering;
		} else {
			this._isHovering = false;
		}
	};

	_onClick = (e) => {
		if (this.explodeState) return; // already exploding
		if (!this.toolSprites || this.toolSprites.length === 0) return;
		
		// Get click position in normalized screen coordinates
		const rect = this.containerEl.getBoundingClientRect();
		const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
		
		const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * this.camera.position.z;
		const halfW = halfH * this.camera.aspect;
		this._mouseWorld.set(x * halfW, y * halfH, 0);
		const clickWorldPos = this._mouseWorld;

		// On portrait (floating mode) any tap explodes; on desktop require hitting a sprite
		if (!this._isPortrait) {
			let clickedSprite = false;
			for (const sprite of this.toolSprites) {
				if (sprite.position.distanceTo(clickWorldPos) < 15) { clickedSprite = true; break; }
			}
			if (!clickedSprite) return;
		}

		this.renderer.domElement.style.cursor = 'default';
		this._lastCursorStyle = 'default';
		this._isHovering = false;

		// Start hammer rotation animation
		this.hammerAnimation = { startTime: this.clock.getElapsedTime(), startRotation: this.hammerRotation };
		
		// Start explosion
		this.explodeState = { phase: 'explode', startTime: this.clock.getElapsedTime() };
		this.explodedVelocities = [];
		this.originalPositions = [];
		this.returnProgress = 0;
		this.spriteBounceCounts = [];
		this.lastVelocitySigns = [];
		this.spriteReturnDelays = [];
		
		// Store original positions and create velocities
		this.toolSprites.forEach((sprite, i) => {
			const pos = sprite.position.clone();
			this.originalPositions[i] = pos;
			
			// Velocity away from click point - INSANELY fast to ensure 5+ bounces
			const dir = pos.clone().sub(clickWorldPos).normalize();
			const speed = 150 + Math.random() * 100; // EXTREMELY fast: 150-250
			this.explodedVelocities[i] = dir.multiplyScalar(speed);
			this.spriteBounceCounts[i] = 0; // initialize bounce counter
			this.lastVelocitySigns[i] = { x: 0, y: 0, z: 0 }; // initialize velocity sign tracking
			
			// Random delay for staggered return (0 to 1.5 seconds)
			this.spriteReturnDelays[i] = Math.random() * 1.5;
		});
	};

	_animate = () => {
		this._raf = requestAnimationFrame(this._animate);
		const t = this.clock.getElapsedTime();
		
		// Handle hammer rotation animation
		if (this.hammerAnimation) {
			const elapsed = t - this.hammerAnimation.startTime;
			const duration = 0.4;

			if (elapsed < duration) {
				const progress = elapsed / duration;
				if (progress < 0.5) {
					const easeIn = (progress * 2) * (progress * 2);
					this.hammerRotation = this.hammerAnimation.startRotation - (Math.PI / 4) * easeIn;
				} else {
					const bounceProgress = (progress - 0.5) * 2;
					const easeOut = 1 - Math.pow(1 - bounceProgress, 3);
					this.hammerRotation = -(Math.PI / 4) + (Math.PI / 4) * easeOut;
				}
			} else {
				this.hammerRotation = 0;
				this.hammerAnimation = null;
			}
		}
		
		// Handle explode animation
		if (this.explodeState) {
			const elapsed = t - this.explodeState.startTime;
			const dt = 0.016;

			if (this.explodeState.phase === 'explode') {
				for (let i = 0; i < this.toolSprites.length; i++) {
					const s = this.toolSprites[i];
					s.position.addScaledVector(this.explodedVelocities[i], dt);
					
					if (s.userData && s.userData.label) {
						const lbl = s.userData.label;
						lbl.position.set(s.position.x, s.position.y - (lbl.userData.yGap || 3.8), s.position.z);
					}
				}
				
				if (elapsed > 0.2) {
					this.explodeState.phase = 'bounce';
					this.explodeState.startTime = t;
				}
			} else if (this.explodeState.phase === 'bounce') {
				const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * this.camera.position.z;
				const halfW = halfH * this.camera.aspect;
				const damping = 0.99;

				for (let i = 0; i < this.toolSprites.length; i++) {
					const s = this.toolSprites[i];
					const lastSign = this.lastVelocitySigns[i];

					s.position.addScaledVector(this.explodedVelocities[i], dt);
					
					// Bounce off LEFT and RIGHT sides
					if (Math.abs(s.position.x) > halfW - 3) {
						// Count bounce if velocity changed direction
						if (lastSign.x !== 0 && Math.sign(this.explodedVelocities[i].x) !== lastSign.x) {
							this.spriteBounceCounts[i]++;
						}
						this.explodedVelocities[i].x *= -damping;
						s.position.x = Math.sign(s.position.x) * (halfW - 3);
					}
					
					// Bounce off TOP and BOTTOM sides
					if (Math.abs(s.position.y) > halfH - 3) {
						// Count bounce if velocity changed direction
						if (lastSign.y !== 0 && Math.sign(this.explodedVelocities[i].y) !== lastSign.y) {
							this.spriteBounceCounts[i]++;
						}
						this.explodedVelocities[i].y *= -damping;
						s.position.y = Math.sign(s.position.y) * (halfH - 3);
					}
					
					// Bounce off Z boundaries
					if (Math.abs(s.position.z) > 50) {
						// Count bounce if velocity changed direction
						if (lastSign.z !== 0 && Math.sign(this.explodedVelocities[i].z) !== lastSign.z) {
							this.spriteBounceCounts[i]++;
						}
						this.explodedVelocities[i].z *= -damping;
						s.position.z = Math.sign(s.position.z) * 50;
					}
					
					// Apply damping
					this.explodedVelocities[i].multiplyScalar(damping);
					
					// Update velocity signs after all bounce logic
					this.lastVelocitySigns[i] = {
						x: Math.sign(this.explodedVelocities[i].x),
						y: Math.sign(this.explodedVelocities[i].y),
						z: Math.sign(this.explodedVelocities[i].z)
					};
					
					if (s.userData && s.userData.label) {
						const lbl = s.userData.label;
						lbl.position.set(s.position.x, s.position.y - (lbl.userData.yGap || 3.8), s.position.z);
					}
				}
				
				// Check if velocities are low enough to resume normal mode
				const avgSpeed = this.explodedVelocities.reduce((sum, vel) => sum + vel.length(), 0) / this.explodedVelocities.length;
				if (avgSpeed < 1.0) {
					if (this._isPortrait) {
						// Resume floating from wherever icons settled — no return animation
						for (const s of this.toolSprites) {
							s.userData.floatX = s.position.x;
							s.userData.floatY = s.position.y;
							// Align phase so sine starts at 0 offset (smooth transition)
							s.userData.floatPhaseX = -(t * s.userData.floatFreqX);
							s.userData.floatPhaseY = -(t * s.userData.floatFreqY);
						}
						this.explodeState = null;
					} else {
						this.explodeState.phase = 'return';
						this.explodeState.startTime = t;
					}
				}
			} else if (this.explodeState.phase === 'return') {
				// Return phase: smoothly return to original rotation paths
				const returnDuration = 2.0;
				const globalProgress = (t - this.explodeState.startTime) / returnDuration;
				
				let allComplete = true;
				
				for (let i = 0; i < this.toolSprites.length; i++) {
					const s = this.toolSprites[i];
					const orig = this.originalPositions[i];
					
					// Calculate individual progress for this sprite based on its delay
					const spriteProgress = Math.max(0, globalProgress - this.spriteReturnDelays[i] / returnDuration);
					const clampedProgress = Math.min(1, spriteProgress);
					
					// Only lerp if this sprite has started returning
					if (spriteProgress > 0) {
						const easeOut = 1 - Math.pow(1 - clampedProgress, 3); // cubic ease-out
						s.position.lerp(orig, easeOut);
						
						if (s.userData && s.userData.label) {
							const lbl = s.userData.label;
							lbl.position.set(s.position.x, s.position.y - (lbl.userData.yGap || 3.8), s.position.z);
						}
					}
					
					// Track if all sprites have completed their return
					if (clampedProgress < 1) {
						allComplete = false;
					}
				}
				
				// End animation and resume normal mode only when all are done
				if (allComplete) {
					if (!this._isPortrait) {
						// Recalculate angle offsets for seamless orbit continuation (desktop only)
						const currentTime = this.clock.getElapsedTime();
						for (let i = 0; i < this.toolSprites.length; i++) {
							const s = this.toolSprites[i];
							const circleScale = Math.min(this.xScale || 1, 0.70);
							const scaledX = s.position.x / circleScale;
							const scaledY = (s.position.y - s.userData.yOffset) / circleScale;
							const currentAngle = Math.atan2(scaledY, scaledX);
							s.userData.angleOffset = currentAngle - (currentTime * s.userData.speed);
						}
					}
					this.explodeState = null;
				}
			}
		} else if (this._isPortrait) {
			// Floating mode on mobile — icons drift naturally across the banner
			this.group.rotation.set(0, 0, 0);
			if (this.toolSprites) {
				for (let i = 0; i < this.toolSprites.length; i++) {
					const s = this.toolSprites[i];
					if (s.userData.floatX === undefined) continue;
					const x = s.userData.floatX + Math.sin(t * s.userData.floatFreqX + s.userData.floatPhaseX) * s.userData.floatAmpX;
					const y = s.userData.floatY + Math.sin(t * s.userData.floatFreqY + s.userData.floatPhaseY) * s.userData.floatAmpY;
					s.position.set(x, y, 0);
					if (s.userData.label) {
						const lbl = s.userData.label;
						lbl.position.set(x, y - (lbl.userData.yGap || 3.8), 0);
					}
				}
			}
		} else {
			// Orbit mode on desktop/landscape
			this.group.rotation.y = this.mouse.x * 0.12;
			this.group.rotation.x = this.mouse.y * 0.08;

			if (this.toolSprites) {
				// Compute once per frame, not once per sprite
				const circleScale = Math.min(this.xScale || 1, 0.70);
				for (let i = 0; i < this.toolSprites.length; i++) {
					const s = this.toolSprites[i];
					const a = t * s.userData.speed + s.userData.angleOffset;
					const r = s.userData.radius * circleScale;
					const sa = Math.sin(a);
					const ca = Math.cos(a);
					s.position.x = ca * r;
					s.position.y = sa * r + (s.userData.yOffset || 0);
					s.position.z = sa * 2;
					if (s.userData.label) {
						const lbl = s.userData.label;
						lbl.position.set(s.position.x, s.position.y - (lbl.userData.yGap || 3.8), s.position.z);
					}
				}
			}

			// Update cursor once per frame (not on every mousemove)
			if (this._isHovering) {
				const url = this._getHammerCursor(this.hammerRotation);
				const style = `url(${url}) 64 64, pointer`;
				if (this._lastCursorStyle !== style) {
					this.renderer.domElement.style.cursor = style;
					this._lastCursorStyle = style;
				}
			} else if (this._lastCursorStyle !== 'default') {
				this.renderer.domElement.style.cursor = 'default';
				this._lastCursorStyle = 'default';
			}
		}
		
		this.renderer.render(this.scene, this.camera);
	};

	_initLogos() {
		const base = 'https://cdn.simpleicons.org/';

		const mapSpecial = (label) => {
			const l = (label || '').toLowerCase();
			const m = {
				'c++': 'cplusplus',
				'node.js': 'nodedotjs',
				'next.js': 'nextdotjs',
				'microsoft sql server': 'microsoftsqlserver',
				'power bi': 'powerbi',
				'azure': 'microsoftazure',
				'aws': 'amazonaws',
				'apache spark / kafka': 'apachespark',
				'pyspark': 'apachespark',
				'xgboost': 'xgboost',
				'scikit-learn': 'scikitlearn',
			};
			if (m[l]) return m[l];
			return l.replace(/\s+/g, '').replace(/[.+]/g, '');
		};

		const entries = [];
		const skillEls = document.querySelectorAll('#skills .skill');
		skillEls.forEach((el) => {
			const img = el.querySelector('img');
			if (img) {
				const dataLabel = img.getAttribute('data-icon') || img.getAttribute('data-skill') || img.getAttribute('data-label');
				const spanLabel = (el.querySelector('span')?.textContent || '').trim();
				const altLabel = img.getAttribute('alt') || '';
				const label = (dataLabel && dataLabel.trim()) || spanLabel || altLabel;
				if (label) {
					entries.push({ slug: mapSpecial(label), label });
					return;
				}
			}
			const fa = el.querySelector('.icon');
			if (fa) {
				const cls = Array.from(fa.classList).find((c) => c.startsWith('fa-')) || '';
				const label = (el.querySelector('span')?.textContent || '').trim();
				const slug = mapSpecial(label || cls.replace('fa-', ''));
				entries.push({ slug, label: label || slug });
			}
		});

		// fallback if nothing found
		if (entries.length === 0) {
			entries.push(
				{ slug: 'react', label: 'React' },
				{ slug: 'nextdotjs', label: 'Next.js' },
				{ slug: 'typescript', label: 'TypeScript' }
			);
		}

		// de-duplicate by slug
		const seen = new Set();
		const tools = entries.filter((e) => {
			if (!e.slug) return false;
			if (seen.has(e.slug)) return false;
			seen.add(e.slug); return true;
		});

		this.toolSprites = [];
		const baseRadius = 45;
		const ringOffset = 14;

		const build = async (i) => {
			const url = base + tools[i].slug;
			const texture = await this._loadSvgTexture(url);
			if (!texture) return; // skip items without a supported icon
			const mat = new THREE.SpriteMaterial({
				map: texture,
				transparent: true,
				depthWrite: false,
				alphaTest: 0.01,
			});
			const sprite = new THREE.Sprite(mat);
			sprite.scale.set(8, 8, 1);
			const ring = i % 2;
			const radius = baseRadius + (ring ? ringOffset : 6);
			const angleOffset = (Math.PI * 2 * i) / tools.length;
			const yOffset = (i % 3 - 1) * 2.0 + (ring ? 0.8 : -0.8);
			const speed = 0.25 + (ring ? 0.12 : 0);
			sprite.userData = { angleOffset, yOffset, radius, speed };
			this.toolSprites.push(sprite);
			this.group.add(sprite);

			const labelTex = this._makeLabelTexture(tools[i].label);
			const labelMat = new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false });
			const label = new THREE.Sprite(labelMat);
			label.center.set(0.5, 1.0);
			const labelH = 2.2;
			const aspect = labelTex.image.width / Math.max(1, labelTex.image.height);
			label.scale.set(labelH * aspect, labelH, 1);
			label.userData = { parent: sprite, yGap: 3.8, baseH: labelH, aspect };
			sprite.userData.label = label;
			this.group.add(label);

			this._onResize();
		};

		for (let i = 0; i < tools.length; i++) build(i);
	}

	_makeLabelTexture(text) {
		const padding = 16;
		const fontSize = 64;
		const font = `${fontSize}px Inter, Arial, Helvetica, sans-serif`;
		const tmp = document.createElement('canvas');
		const ctx = tmp.getContext('2d');
		ctx.font = font;
		const metrics = ctx.measureText(text);
		const w = Math.ceil(metrics.width + padding * 2);
		const h = Math.ceil(fontSize + padding * 2);
		const pot = (n) => Math.pow(2, Math.ceil(Math.log2(Math.max(2, n))));
		tmp.width = pot(w);
		tmp.height = pot(h);
		const cx = tmp.getContext('2d');
		cx.clearRect(0, 0, tmp.width, tmp.height);
		cx.font = font;
		cx.textAlign = 'center';
		cx.textBaseline = 'middle';
		cx.shadowColor = 'rgba(0,0,0,0.65)';
		cx.shadowBlur = 8;
		cx.fillStyle = '#ffffff';
		cx.fillText(text, tmp.width / 2, tmp.height / 2);
		const tex = this._configureSpriteTexture(new THREE.CanvasTexture(tmp));
		return tex;
	}
}



