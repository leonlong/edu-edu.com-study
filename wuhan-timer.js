// ==UserScript==
// @name         武汉理工自考平台 - 定时器版（最终版）
// @namespace    http://tampermonkey.net/
// @version      11.0.0
// @description  增强版：定时检测、自动续播、自动下一章、弹窗清理、可视化控制
// @author       Based on OCS 网课助手
// @match        *://*.edu-edu.com/*
// @match        *://cws.edu-edu.com/*
// @grant        GM_addStyle
// @grant        GM_notification
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    if (window.__WUHAN_TIMER_V11_RUNNING__) {
        console.log('[武汉理工-增强版] 脚本已在当前页面运行，跳过重复初始化');
        return;
    }
    window.__WUHAN_TIMER_V11_RUNNING__ = true;

    var CONFIG = {
        checkInterval: 3000,
        chapterDetectIntervalMs: 2000,
        maxRetries: 10,
        clickDelayMs: 3000,
        videoEndedThreshold: 0.5,
        startDelayMs: 1500,
        noVideoReloadMs: 90000,
        noVideoLogIntervalMs: 10000,
        progressLogStep: 25
    };

    var Logger = {
        log: function() {
            if (State.settings && State.settings.debug) {
                console.log.apply(console, ['[武汉理工-增强版]'].concat(Array.from(arguments)));
            }
        },
        warn: function() {
            console.warn.apply(console, ['[武汉理工-增强版]'].concat(Array.from(arguments)));
        },
        error: function() {
            console.error.apply(console, ['[武汉理工-增强版]'].concat(Array.from(arguments)));
        }
    };

    var Settings = {
        key: 'wuhan.timer.v11.settings',
        defaults: {
            debug: true,
            autoPlay: true,
            autoNextChapter: true,
            autoCloseDialogs: true,
            reloadWhenNoVideo: true,
            muted: true,
            volume: 0,
            playbackRate: 1.5,
            checkInterval: 3000
        },
        load: function() {
            try {
                var raw = localStorage.getItem(this.key);
                if (!raw) return Object.assign({}, this.defaults);
                var parsed = JSON.parse(raw);
                return Object.assign({}, this.defaults, parsed);
            } catch (e) {
                return Object.assign({}, this.defaults);
            }
        },
        save: function(partial) {
            var next = Object.assign({}, State.settings || this.defaults, partial || {});
            State.settings = next;
            localStorage.setItem(this.key, JSON.stringify(next));
            return next;
        }
    };

    var State = {
        videoElement: null,
        chapters: [],
        currentChapter: null,
        lastChapterIndex: -1,
        isProcessing: false,
        domReady: false,
        observerInitialized: false,
        initialCheckDone: false,
        lastCheckTime: 0,
        monitorTimer: null,
        lastHandledVideoKey: '',
        lastNoVideoLogAt: 0,
        noVideoSince: 0,
        lastProgressBucket: -1,
        panelInitialized: false,
        settings: null,
        isTopWindow: true,
        panelCollapsed: false
    };

    var UI = {
        ensureStyle: function() {
            if (document.getElementById('wuhan-timer-panel-style')) return;
            var css = '#wuhan-timer-panel{position:fixed;top:80px;right:16px;z-index:2147483647;width:240px;background:rgba(20,20,28,.92);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:10px;padding:10px;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.28)}#wuhan-timer-panel .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}#wuhan-timer-panel .row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px}#wuhan-timer-panel .title{font-weight:700;font-size:13px}#wuhan-timer-panel .tip{opacity:.75;font-size:11px;margin-bottom:8px}#wuhan-timer-panel input[type="range"]{width:120px}#wuhan-timer-panel select,#wuhan-timer-panel button{background:#2b2f3a;color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:3px 6px;font-size:12px}#wuhan-timer-panel button{cursor:pointer}#wuhan-timer-panel[data-collapsed="1"] .body{display:none}';
            if (typeof GM_addStyle === 'function') {
                GM_addStyle(css);
            } else {
                var style = document.createElement('style');
                style.id = 'wuhan-timer-panel-style';
                style.textContent = css;
                document.head.appendChild(style);
            }
        },
        create: function() {
            if (!State.isTopWindow) return;
            if (State.panelInitialized) return;
            this.ensureStyle();
            var oldPanel = document.getElementById('wuhan-timer-panel');
            if (oldPanel && oldPanel.parentNode) {
                oldPanel.parentNode.removeChild(oldPanel);
            }
            var panel = document.createElement('div');
            panel.id = 'wuhan-timer-panel';
            panel.innerHTML = '' +
                '<div class="header"><div class="title">网课助手增强版</div><button data-action="collapse">收起</button></div>' +
                '<div class="body">' +
                '<div class="tip">勾选表示启用该项功能</div>' +
                '<div class="row"><span>自动播放</span><input data-key="autoPlay" type="checkbox"></div>' +
                '<div class="row"><span>自动下一章</span><input data-key="autoNextChapter" type="checkbox"></div>' +
                '<div class="row"><span>弹窗清理</span><input data-key="autoCloseDialogs" type="checkbox"></div>' +
                '<div class="row"><span>无视频自动刷新</span><input data-key="reloadWhenNoVideo" type="checkbox"></div>' +
                '<div class="row"><span>调试日志</span><input data-key="debug" type="checkbox"></div>' +
                '<div class="row"><span>静音</span><input data-key="muted" type="checkbox"></div>' +
                '<div class="row"><span>倍速</span><select data-key="playbackRate"><option value="1">1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="1.75">1.75x</option><option value="2">2x</option><option value="2.5">2.5x</option><option value="3">3x</option></select></div>' +
                '<div class="row"><span>音量</span><input data-key="volume" type="range" min="0" max="1" step="0.05"></div>' +
                '<div class="row"><span>检测间隔</span><select data-key="checkInterval"><option value="1500">1.5s</option><option value="3000">3s</option><option value="5000">5s</option></select></div>' +
                '<div class="row"><button data-action="play">播放</button><button data-action="next">下一章</button></div>' +
                '</div>';
            document.body.appendChild(panel);
            this.bind(panel);
            this.sync(panel);
            State.panelInitialized = true;
        },
        bind: function(panel) {
            panel.addEventListener('change', function(event) {
                var target = event.target;
                var key = target.getAttribute('data-key');
                if (!key) return;
                var value = target.type === 'checkbox' ? target.checked : target.value;
                if (key === 'playbackRate' || key === 'volume' || key === 'checkInterval') {
                    value = parseFloat(value);
                }
                Settings.save((function() {
                    var obj = {};
                    obj[key] = value;
                    return obj;
                })());
                if (key === 'checkInterval') {
                    Controller.restartMonitoring();
                }
            });
            panel.addEventListener('click', function(event) {
                var target = event.target;
                var action = target.getAttribute('data-action');
                if (!action) return;
                if (action === 'collapse') {
                    State.panelCollapsed = !State.panelCollapsed;
                    panel.setAttribute('data-collapsed', State.panelCollapsed ? '1' : '0');
                    target.textContent = State.panelCollapsed ? '展开' : '收起';
                } else if (action === 'play') {
                    var video = VideoDetector.detectVideo();
                    if (video) {
                        video.play().catch(function(e) {
                            Logger.error('手动播放失败:', e);
                        });
                    }
                } else if (action === 'next') {
                    ChapterDetector.clickNextChapter();
                }
            });
        },
        sync: function(panel) {
            var settings = State.settings || Settings.defaults;
            Array.prototype.forEach.call(panel.querySelectorAll('[data-key]'), function(el) {
                var key = el.getAttribute('data-key');
                var value = settings[key];
                if (el.type === 'checkbox') {
                    el.checked = !!value;
                } else {
                    el.value = String(value);
                }
            });
        }
    };

    var DialogHandler = {
        close: function() {
            if (!State.settings || !State.settings.autoCloseDialogs) return;
            var wrappers = document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper, .ant-modal-wrap, .v-modal');
            Array.prototype.forEach.call(wrappers, function(wrapper) {
                var closeBtn = wrapper.querySelector('.el-dialog__headerbtn, .el-message-box__close, .ant-modal-close, [aria-label="Close"], [class*="close"]');
                if (closeBtn && closeBtn.click) {
                    closeBtn.click();
                } else if (wrapper.parentNode && wrapper.className.indexOf('v-modal') === -1) {
                    wrapper.parentNode.removeChild(wrapper);
                }
            });
        }
    };

    var NextButtonNavigator = {
        texts: ['下一章', '下一节', '下一个', '继续学习', '继续', 'next', 'continue'],
        click: function() {
            var nodes = document.querySelectorAll('button, a, [role="button"], .btn, .button');
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                var text = (node.textContent || '').trim().toLowerCase();
                if (!text) continue;
                for (var j = 0; j < this.texts.length; j++) {
                    if (text.indexOf(this.texts[j]) !== -1) {
                        if (node.click) {
                            node.click();
                            Logger.log('通过按钮文本触发下一章: ' + text.substring(0, 20));
                            return true;
                        }
                    }
                }
            }
            return false;
        }
    };

    var ChapterDetector = {
        selectors: [
            '.videoBox',              // ⭐ 正确的选择器
            '.videoBox.active',
            '[class*="videoBox"]',
        ],

        detectChapters: function() {
            Logger.log('检测章节列表...');

            for (var i = 0; i < this.selectors.length; i++) {
                var selector = this.selectors[i];
                try {
                    var elements = document.querySelectorAll(selector);
                    
                    if (elements && elements.length > 0) {
                        Logger.log('找到 ' + elements.length + ' 个章节元素: ' + selector);
                        State.chapters = Array.from(elements);
                        
                        for (var j = 0; j < Math.min(5, State.chapters.length); j++) {
                            var chapter = State.chapters[j];
                            var text = chapter.textContent ? chapter.textContent.trim().substring(0, 40) : '';
                            Logger.log('  章节 ' + j + ': ' + text);
                        }
                        
                        State.initialCheckDone = true;
                        return State.chapters;
                    }
                } catch (error) {
                    Logger.warn('选择器 ' + selector + ' 检测失败:', error);
                }
            }

            Logger.warn('所有选择器都未能检测到章节');
            Logger.log('调试信息:', {
                bodyChildren: document.body ? document.body.children.length : 0,
                liElements: document.querySelectorAll('li').length,
                videoBoxElements: document.querySelectorAll('.videoBox').length
            });
            
            return [];
        },

        startPeriodicDetection: function() {
            Logger.log('启动周期性章节检测');
            
            var retryCount = 0;
            var self = this;
            
            var detectInterval = setInterval(function() {
                if (State.chapters.length > 0) {
                    Logger.log('章节列表已找到，停止周期性检测');
                    clearInterval(detectInterval);
                    return;
                }
                
                Logger.log('周期性检测 (' + (retryCount + 1) + '/' + CONFIG.maxRetries + ')...');
                self.detectChapters();
                
                retryCount++;
                
                if (retryCount >= CONFIG.maxRetries) {
                    Logger.warn('达到最大重试次数，停止周期性检测');
                    clearInterval(detectInterval);
                }
            }, CONFIG.chapterDetectIntervalMs);
        },

        startDOMObserver: function() {
            if (State.observerInitialized) return;
            
            Logger.log('启动 DOM 变化监听');
            
            try {
                var self = this;
                var observer = new MutationObserver(function(mutations) {
                    mutations.forEach(function(mutation) {
                        if (mutation.addedNodes && mutation.addedNodes.length > 0) {
                            Logger.log('检测到 DOM 变化，重新检测章节');
                            self.detectChapters();
                        }
                    });
                });
                
                if (document.body) {
                    observer.observe(document.body, {
                        childList: true,
                        subtree: true
                    });
                    State.observerInitialized = true;
                    Logger.log('DOM 变化监听已启动');
                } else {
                    Logger.warn('document.body 未准备好，稍后重试');
                    setTimeout(function() {
                        self.startDOMObserver();
                    }, 1000);
                }
            } catch (error) {
                Logger.error('启动 DOM 监听失败:', error);
            }
        },

        getCurrentChapter: function() {
            if (State.chapters.length === 0) {
                Logger.warn('章节列表为空');
                return null;
            }

            var activeSelectors = [
                '.videoBox.active',                  // ⭐ 正确的选择器
                '.videoBox[class*="active"]',
                'li.videoBox.active',
                '[class*="videoBox"][class*="active"]'
            ];
            
            for (var i = 0; i < activeSelectors.length; i++) {
                var element = document.querySelector(activeSelectors[i]);
                if (element && State.chapters.indexOf(element) !== -1) {
                    var text = element.textContent ? element.textContent.trim().substring(0, 40) : '';
                    Logger.log('当前章节 (' + activeSelectors[i] + '): ' + text);
                    
                    // 更新索引
                    State.lastChapterIndex = State.chapters.indexOf(element);
                    return element;
                }
            }

            var currentUrl = window.location.href;
            for (var j = 0; j < State.chapters.length; j++) {
                var chapter = State.chapters[j];
                var link = chapter.querySelector('a');
                if (link && link.href) {
                    if (currentUrl.indexOf(link.href) !== -1 || link.href.indexOf(currentUrl) !== -1) {
                        State.lastChapterIndex = j;
                        return chapter;
                    }
                }
            }

            return null;
        },

        getNextChapter: function() {
            if (State.chapters.length === 0) {
                Logger.warn('章节列表为空');
                return null;
            }

            var current = this.getCurrentChapter();
            
            if (!current) {
                if (State.lastChapterIndex >= 0 && State.lastChapterIndex < State.chapters.length - 1) {
                    return State.chapters[State.lastChapterIndex + 1];
                }
                Logger.log('未找到当前章节，返回第一个章节');
                return State.chapters[0];
            }

            var currentIndex = State.chapters.indexOf(current);
            
            if (currentIndex === -1) {
                Logger.warn('当前章节不在章节列表中');
                return null;
            }

            if (currentIndex >= State.chapters.length - 1) {
                Logger.log('当前是最后一个章节');
                return null;
            }

            var next = State.chapters[currentIndex + 1];
            var text = next.textContent ? next.textContent.trim().substring(0, 40) : '';
            Logger.log('下一个章节: ' + text);
            return next;
        },

        clickChapter: function(chapter) {
            if (State.isProcessing) {
                Logger.log('正在处理中，跳过');
                return false;
            }

            try {
                State.isProcessing = true;
                var text = chapter.textContent ? chapter.textContent.trim().substring(0, 40) : '';
                Logger.log('点击章节: ' + text);

                var link = chapter.querySelector('a');
                if (link) {
                    var href = link.href ? link.href.substring(0, 60) : '';
                    Logger.log('找到链接: ' + href);
                    
                    if (link.click) {
                        link.click();
                        Logger.log('已点击链接');
                    } else {
                        var event = new MouseEvent('click', {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        });
                        link.dispatchEvent(event);
                        Logger.log('已派发链接点击事件');
                    }
                } else {
                    if (chapter.click) {
                        chapter.click();
                        Logger.log('已点击 .videoBox 元素');
                    } else {
                        var event = new MouseEvent('click', {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        });
                        chapter.dispatchEvent(event);
                        Logger.log('已派发 .videoBox 点击事件');
                    }
                }

                setTimeout(function() {
                    State.isProcessing = false;
                }, CONFIG.clickDelayMs);

                return true;
            } catch (error) {
                Logger.error('点击章节失败:', error);
                State.isProcessing = false;
                return false;
            }
        },

        clickNextChapter: function() {
            var next = this.getNextChapter();
            if (next && this.clickChapter(next)) {
                return true;
            }
            if (NextButtonNavigator.click()) {
                return true;
            }
            Logger.warn('没有下一个章节');
            return false;
        }
    };

    var VideoDetector = {
        detectVideo: function() {
            return document.querySelector('video');
        },
        applySettings: function(video) {
            if (!video || !State.settings) return;
            if (isFinite(State.settings.playbackRate) && State.settings.playbackRate > 0 && video.playbackRate !== State.settings.playbackRate) {
                video.playbackRate = State.settings.playbackRate;
            }
            if (typeof State.settings.muted === 'boolean') {
                video.muted = State.settings.muted;
            }
            if (typeof State.settings.volume === 'number' && isFinite(State.settings.volume)) {
                video.volume = Math.max(0, Math.min(1, State.settings.volume));
            }
        },

        checkVideoStatus: function() {
            var video = this.detectVideo();
            if (!video) {
                var now = Date.now();
                if (!State.noVideoSince) {
                    State.noVideoSince = now;
                }
                if (now - State.lastNoVideoLogAt > CONFIG.noVideoLogIntervalMs) {
                    Logger.warn('未检测到 video 元素');
                    State.lastNoVideoLogAt = now;
                }
                if (State.settings && State.settings.reloadWhenNoVideo && now - State.noVideoSince > CONFIG.noVideoReloadMs) {
                    Logger.warn('长时间未检测到视频，准备刷新页面');
                    window.location.reload();
                    return;
                }
                return;
            }
            State.noVideoSince = 0;
            this.applySettings(video);

            var duration = video.duration;
            var currentTime = video.currentTime;
            var isPaused = video.paused;
            var isEnded = video.ended;
            var current = ChapterDetector.getCurrentChapter();
            var chapterTitle = current && current.textContent ? current.textContent.trim().substring(0, 60) : '';
            var src = video.currentSrc || video.src || '';
            var videoKey = chapterTitle + '|' + src + '|' + (isFinite(duration) ? duration.toFixed(2) : '0');

            var isFinished = (duration > 0 && Math.abs(duration - currentTime) < CONFIG.videoEndedThreshold) || isEnded;
            
            if (isFinished) {
                if (State.lastHandledVideoKey === videoKey) {
                    return;
                }
                State.lastHandledVideoKey = videoKey;
                Logger.log('视频已结束 (时长: ' + duration.toFixed(2) + 's, 当前: ' + currentTime.toFixed(2) + 's)');
                this.onVideoEnded();
            } else if (isPaused && duration > 0) {
                if (State.settings && State.settings.autoPlay) {
                    Logger.log('视频已暂停，尝试恢复播放');
                    video.play().catch(function(e) {
                        Logger.error('恢复播放失败:', e);
                    });
                }
            } else if (duration > 0) {
                State.lastHandledVideoKey = '';
                var progress = (currentTime / duration) * 100;
                var bucket = Math.floor(progress / CONFIG.progressLogStep);
                if (bucket !== State.lastProgressBucket) {
                    State.lastProgressBucket = bucket;
                    Logger.log('视频播放中: ' + progress.toFixed(1) + '%');
                }
            } else {
                Logger.log('视频未就绪');
            }
        },

        onVideoEnded: function() {
            Logger.log('视频结束，准备跳转下一章节');
            
            if (State.settings && State.settings.autoNextChapter) {
                setTimeout(function() {
                    ChapterDetector.clickNextChapter();
                }, 1000);
            }
        }
    };

    var Controller = {
        init: function() {
            State.settings = Settings.load();
            try {
                State.isTopWindow = window.top === window.self;
            } catch (e) {
                State.isTopWindow = true;
            }
            Logger.log('初始化武汉理工自考平台增强版');
            Logger.log('当前设置:', State.settings);
            
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', function() {
                    Controller.onDOMReady();
                }, { once: true });
            } else {
                this.onDOMReady();
            }
        },

        onDOMReady: function() {
            if (State.domReady) {
                return;
            }
            Logger.log('DOM 已准备好');
            State.domReady = true;
            UI.create();

            setTimeout(function() {
                Controller.startUp();
            }, CONFIG.startDelayMs);
        },

        startUp: function() {
            Logger.log('启动监控');

            ChapterDetector.startPeriodicDetection();
            ChapterDetector.startDOMObserver();

            this.startMonitoring();
        },

        startMonitoring: function() {
            if (State.monitorTimer) {
                return;
            }
            var interval = (State.settings && State.settings.checkInterval) || CONFIG.checkInterval;
            Logger.log('启动定时器监控（' + (interval / 1000) + ' 秒间隔）');

            State.monitorTimer = setInterval(function() {
                Controller.tick();
            }, interval);
        },

        restartMonitoring: function() {
            if (State.monitorTimer) {
                clearInterval(State.monitorTimer);
                State.monitorTimer = null;
            }
            this.startMonitoring();
        },

        tick: function() {
            var now = Date.now();
            
            if (State.chapters.length === 0) {
                ChapterDetector.detectChapters();
            } else {
                var current = ChapterDetector.getCurrentChapter();
                if (current && current !== State.currentChapter) {
                    Logger.log('章节已切换');
                    State.currentChapter = current;
                }
            }

            DialogHandler.close();
            VideoDetector.checkVideoStatus();

            State.lastCheckTime = now;
        }
    };

    Controller.init();

})();
