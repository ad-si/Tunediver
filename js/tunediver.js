(function (w, d, undefined) {

    var baseURL = "/~adriansieber/tunediver";

    var T = {
        version:"12.02",
        player:new Player()
    };


    function highlight(element) {
        var links = $('c2').getElementsByTagName('a');
        for (var i = 0; i < links.length; i++) {
            links[i].className = null;
        }
        element.className = 'highlight';
    }

    function $(e) {
        return d.getElementById(e);
    }

    function Player() {

        function favicon(state) {

            var ctx,
                canvas = document.createElement('canvas'),
                img = document.createElement('img'),
                link = $('favicon').cloneNode(true);

            if (state) {
                canvas.height = canvas.width = 16;
                ctx = canvas.getContext('2d');
                img.onload = function () {

                    ctx.drawImage(this, 0, 0);
                    ctx.font = '900 8px sans-serif';
                    ctx.fillStyle = '#111';
                    ctx.fillText('▶', 8, 16);

                    link.href = canvas.toDataURL('image/png');
                    link.id = "faviconPlay";
                    document.head.appendChild(link);
                };
                img.src = baseURL + '/img/favicon.png';
            } else if (!state) {
                document.head.removeChild($('faviconPlay'));
                $('favicon').href = baseURL + '/img/favicon.png';
            } else {
                throw new Error(state + 'is not a possible state of the favicon.');
            }
        }


        function setPlayingState(state) {
            if (state == "playing") {
                T.audio.play();
                $('play').className = 'playing';
                favicon(true);

            } else if (state == "paused") {
                T.audio.pause();
                $('play').className = 'paused';
                favicon(false);

            } else {
                throw new Error('Unknown playing state:' + state);
            }
        }

        function playerUpdater() {
            $('time').innerHTML = timeElapsed();
            $('duration').innerHTML = timeLeft();
            $('progress').value = T.audio.currentTime;
            $('progress').max = T.audio.duration;
        }

        function timeLeft() {
            var dur = parseInt(T.audio.duration),
                currentTime = parseInt(T.audio.currentTime),
                timeLeft = dur - currentTime,
                s,
                m;

            s = timeLeft % 60;
            m = parseInt(timeLeft / 60 % 60);

            return (s < 10) ? (m + ':0' + s) : (m + ':' + s);
        }

        function timeElapsed() {
            var s = parseInt(T.audio.currentTime % 60);
            var m = parseInt(T.audio.currentTime / 60 % 60);

            return (s < 10) ? (m + ':0' + s) : (m + ':' + s);
        }

        this.playpause = function () {
            if (T.audio.paused && T.audio.src) {
                setPlayingState('playing');
            } else if (!T.audio.paused) {
                setPlayingState('paused');
            } else {
                throw new Error('No song loaded.');
            }
        };

        this.init = function () {

            T.audio = new Audio();
            T.audio.addEventListener("timeupdate", playerUpdater, false);
            T.audio.addEventListener("ended", function () {
                $('play').className = 'paused';
            }, false);
            T.audio.volume = 0.5;

            DOMinate(
                [$('controls'),
                    ['button#queue'],
                    ['button#previous'],
                    ['button#play', {'class':'paused'}],
                    ['button#next'],
                    ['span#time', '0:00'],
                    //['input#progress', {type:'range', min:0, value:0}],
                    ['span#playerInfo','Artist - Song'],
                    ['div#slider.inputBar',
                        ['div#.progress'],
                        ['div#.handler']
                    ],
                    ['span#duration', '0:00'],
                    ['button#mute', '-'],
                    //['input#volume', {type:'range', min:0, max:1, step:0.01}],
                    ['div#volume.inputBar',
                        ['div#.progress'],
                        ['div#.handler']
                    ],
                    ['button#loud', '+']
                ]
            );

            $('play').addEventListener('click', function () {
                T.player.playpause();
            });

            $('progress').addEventListener('mousedown', function () {
                if (T.audio.src)
                    T.audio.removeEventListener("timeupdate", playerUpdater, false);
            }, false);

            $('progress').addEventListener('mouseup', function () {
                if (T.audio.src) {
                    T.audio.currentTime = parseFloat(this.value);
                    T.audio.addEventListener("timeupdate", playerUpdater, false);
                }
            }, false);

            $('mute').addEventListener('click', function () {
                T.audio.volume = $('volume').value = 0;
            }, false);

            $('volume').addEventListener('change', function () {
                T.audio.volume = parseFloat(this.value);
            }, false);

            $('loud').addEventListener('click', function () {
                T.audio.volume = $('volume').value = 1;
            }, false);

        };
    }

    function ajax(url, param, func) {

        var base = 'proxy.php',
            x = new XMLHttpRequest(),
            str = "",
            res,
            path;

        for (var a in param) {
            str += a + '=' + param[a] + '&';
        }

        // loading spinner
        if ($('spinner').style.display == "none") {
            $('spinner').style.display = "inline-block";
        }

        path = base + url + '?' + str;

        x.open('get', path, true);
        x.send(null);
        x.onreadystatechange = function () {
            if (x.readyState == 4 && x.status == 200) {

                $('spinner').style.display = "none";

                res = JSON.parse(x.responseText);

                if (res.success){
                    if (res.data)
                        func(res.data);
                    else
                        throw new Error('No data available for ' + path);
                }else{
                    alert(res.error.message);
                }

            } else if (x.readyState == 4) {
                throw new Error('Http error ' + x.status + ' occured during an ajax request.');
            }
        }
    }


    var print = {};
    print.artists = function () {

        $('c2').style.display = "inline-block";
        $('c4').innerHTML = '';


        ajax('/', {artists: true}, function (artists) {

            $('c2').innerHTML = "";

            artists.forEach(function (artist) {

                var link = DOMinate(['a', artist.name]);

                link.addEventListener('click', function (e) {
                    e.preventDefault();
                    highlight(this);

                    print.songs(artist.slug);
                    print.artist(artist.slug);

                    history.pushState({"url":artist.slug}, artist.slug, baseURL + '/' + artist.slug);
                });

                $('c2').appendChild(link);
            });
        });
    };

    print.artist = function (slug) {

        // Portrait
        ajax('/', {artist: slug}, function (artist) {

            $('c4').innerHTML = '';

            DOMinate(
                [$('c4'),
                    ['div#artist',
                        ['img', {
                            src:baseURL + "/img/cornerstoneGreen.png",
                            alt:'Image of' + artist.name}
                        ],
                        ['nav#artistNav',
                            ['h2#heading', artist.name],
                            ['p#country', artist['country:ext'] || 'Niemandsland']
                        ],
                        ['button#launch', 'Launch'],
                        ['button#suggest', 'Suggest'],
                        ['button#bookmark', 'Bookmark'],
                        ['div#bio', artist.bio],
                        ['div#songs',
                            ['h3', 'Songs']
                        ],
                        ['div#event',
                            ['h3', 'Next Event']
                        ],
                        ['div#news',
                            ['h3', 'Latest News']
                        ]
                    ]
                ]
            );

            $('suggest').addEventListener('click', function () {
                alert('Share this song');
            });

            // Songs
            ajax('artist/~' + slug + '/song', {}, function (songs) {

                songs.forEach(function (song) {

                    var link = DOMinate(['a', song.title]);

                    link.addEventListener('click', function (e) {
                        e.preventDefault();
                        print.song(song.slug, slug);

                        //Save in history object
                        var url = slug + '/' + song.slug;
                        history.pushState({"url":url}, song.slug, url);

                    }, false);

                    DOMinate([$('songs'), [link]]);
                });

            });

            // Events
            ajax('artist/~' + slug + '/event', {"_limit":1}, function (events) {

                DOMinate(
                    [$('event'),
                        ['div',
                            ['b', events[0].start_date.date],
                            ['span', events[0].title]
                        ]
                    ]
                );

            });

            // News
            ajax('artist/~' + slug + '/news', {"_limit":1}, function (news) {

                DOMinate(
                    [$('news'),
                        ['div',
                            ['b', news[0].title],
                            ['span', news[0].text]
                        ]
                    ]
                );

            });

        });
    };

    print.songs = function (artistSlug) {

        ajax('/', {artist: artistSlug, songs: true}, function (songs) {

            $('c3').innerHTML = '';

            songs.forEach(function (song) {

                var link = DOMinate(['a', song.title]);

                link.addEventListener('click', function (e) {
                    e.preventDefault();
                    print.song(song.slug, artistSlug);

                    //Save in history object
                    var url = artistSlug + '/' + song.slug;
                    history.pushState({"url":url}, song.slug, url);

                }, false);

                var container = DOMinate(
                    ['div',
                        [link],
                        ['button', 'Play'],
                        ['button', 'Add to playlist'],
                        ['button', ''],
                        ['span.popularity'],
                        ['span.duration']
                    ]
                );

                $('c3').appendChild(container);
            });
        });
    };

    print.song = function (songSlug, artistSlug) {

        ajax('/', {song: songSlug}, function (song) {

            $('c4').innerHTML = '';

            DOMinate(
                [$('c4'),
                    ['div#song',
                        ['button#playSong', 'Play'],
                        ['img', {
                            'src':baseURL + "/img/cornerstoneGreen.png",
                            'alt':'Image of' + song.track_artist}
                        ],
                        ['nav#songNav',
                            ['h2#heading', song.title],
                            ['p#trackArtist', song.track_artist],
                            ['button#launch', 'Launch'],
                            ['button#suggest', 'Suggest'],
                            ['button#bookmark', 'Bookmark']
                        ],
                        ['pre#lyrics', song.lyrics]
                    ]
                ]
            );

            $('playSong').addEventListener('click', function () {

                if (song.src != "")
                    T.audio.src = song.src.mp3.src
                else {
                    throw new Error('No source available for the song ' + song.title);
                }


                T.player.playpause();
                $('playerInfo').innerHTML = song.track_artist + ' - ' + song.title + '<br/>';

            }, false);
        });

    };

    print.startpage = function () {
        DOMinate(
            [$('c4'),
                ['h2', 'Welcome to tunediver'
                ]
            ]
        );
    };


    function route(state) {

        // Check if first call
        if (!$('logo')) view().index();

        // History object or URL
        if (typeof(state) == "object") {

            if (state.url) {
                fromURL(state.url);
            } else {
                throw new Error('History Object does not contain an URL: ' + state.url);
            }

        } else if (typeof(state) == "string") {
            fromURL(state);
        } else {
            throw new Error('The variable passed to route() is not an object or a string: ' + state);
        }

        function fromURL(url) {
            var dirs = url.split('/');

            console.log(dirs);

            if (dirs.length == 1 && dirs[0] != "") view().artist(dirs);

            else if (dirs.length == 2) view().song(dirs);

            else if (url == '') {
            }
            else if (url != '') {
                alert('This website is not available');
                throw new Error('Can not route the URL ' + url);
            }
        }
    }

    function view() {

        return{
            framework:function () {

                DOMinate(
                    [d.body,
                        ['div#wrapper',
                            ['nav#nav',
                                ['h1#logo', 'tunediver',
                                    ['img#spinner', {
                                        "src":"data:image/svg+xml,%3C?xml%20version=%221.0%22%20encoding=%22utf-8%22?%3E%3Csvg%20width=%2220%22%20height=%2220%22%20xmlns=%22http://www.w3.org/2000/svg%22%20xmlns:xlink=%22http://www.w3.org/1999/xlink%22%3E%3Cdefs%3E%3Crect%20id=%22l%22%20x=%222%22%20y=%22-1%22%20rx=%221%22%20ry=%221%22%20width=%228%22%20height=%222%22%20fill=%22#000%22%3E%3C/rect%3E%3C/defs%3E%3Cg%20transform=%22translate(10,%2010)%22%3E%3Canimatetransform%20attributename=%22transform%22%20calcmode=%22discrete%22%20type=%22rotate%22%20values=%220;30;60;90;120;150;180;210;240;270;300;330;360%22%20additive=%22sum%22%20dur=%221000ms%22%20repeatdur=%22indefinite%22%3E%3C/animatetransform%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(0)%22%20opacity=%220%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(30)%22%20opacity=%220.08%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(60)%22%20opacity=%220.17%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(90)%22%20opacity=%220.25%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(120)%22%20opacity=%220.33%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(150)%22%20opacity=%220.42%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(180)%22%20opacity=%220.5%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(210)%22%20opacity=%220.58%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(240)%22%20opacity=%220.67%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(270)%22%20opacity=%220.75%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(300)%22%20opacity=%220.83%22%3E%3C/use%3E%3Cuse%20xlink:href=%22#l%22%20transform=%22rotate(330)%22%20opacity=%220.92%22%3E%3C/use%3E%3C/g%3E%3C/svg%3E",
                                        "style":"display:none"}
                                    ]
                                ],
                                ['div#controls'],
                                ['input#search', {type:'search', placeholder:'search'}]
                            ],
                            ['div#c1',
                                ['button#interprets', 'Interprets'],
                                ['button#songs', 'Songs'],
                                ['button#charts', 'Charts'],
                                ['button#playlists', 'Playlists']
                            ],
                            ['div#c2'],
                            ['div#c3'],
                            ['div#c4']
                        ]
                    ]
                );

                $('logo').addEventListener('click', function () {
                    window.location = baseURL;
                });

                $('charts').addEventListener('click', function () {
                    print.songs();
                });

                $('interprets').addEventListener('click', function () {
                    print.artists();
                });
            },

            index:function () {
                view().framework();
                T.player.init();
                print.startpage();
            },

            artist:function (dirs) {
                print.artists();
                print.songs(dirs[0]);
                print.artist(dirs[0]);
            },

            artists:function (dirs) {
                print.artists();
            },

            song:function (dirs) {
                print.artists();
                print.songs(dirs[0]);
                print.song(dirs[1], dirs[0]);
            }
        };
    }


    function setShortcuts() {
        addEventListener('keydown', function (e) {
            if (e.keyCode == 32) {
                e.preventDefault();
                (T.audio.paused) ? T.audio.play() : T.audio.pause();
            }
        }, false);
    }

    function init() {
        var path = location.pathname.substr(baseURL.length + 1, location.pathname.length);

        history.replaceState({"url":path}, path, baseURL + '/' + path);

        route(path);

        setShortcuts();

        //Popstate
        window.addEventListener('popstate', function (event) {
            if (event.state != null) {
                route(event.state);
            }
        }, false);

    }

    init();

    tunediver = T;

})(window, document);