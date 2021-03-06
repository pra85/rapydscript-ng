/*
 * repl.js
 * Copyright (C) 2015 Kovid Goyal <kovid at kovidgoyal.net>
 *
 * Distributed under terms of the BSD license.
 */
"use strict";  /*jshint node:true */

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var util = require('util');
var utils = require('./utils');
var colored = utils.safe_colored;
var RapydScript = (typeof create_rapydscript_compiler === 'function') ? create_rapydscript_compiler() : require('./compiler').create_compiler();

function create_ctx(baselib, show_js, console) {
    var ctx = vm.createContext({'console':console, 'show_js': !!show_js, 'RapydScript':RapydScript, 'require':require});
	vm.runInContext(baselib, ctx, {'filename':'baselib-plain-pretty.js'});
	RapydScript.AST_Node.warn_function = function() {};
    return ctx;
}


var homedir = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
var cachedir = expanduser(process.env.XDG_CACHE_HOME || '~/.cache');
var all_keywords = RapydScript.ALL_KEYWORDS.split(' ');
var enum_global = "var global = Function('return this')(); Object.getOwnPropertyNames(global);";

function expanduser(x) {
  if (!x) return x;
  if (x === '~') return homedir;
  if (x.slice(0, 2) != '~/') return path;
  return path.join(homedir, x.slice(2));
}

function read_baselib(lib_path) {
    return fs.readFileSync(path.join(lib_path, 'baselib-plain-pretty.js'), 'utf-8');
}

function repl_defaults(options) {
    options = options || {};
    if (!options.input) options.input = process.stdin;
    if (!options.output) options.output = process.stdout;
    if (options.show_js === undefined) options.show_js = true;
    if (!options.ps1) options.ps1 = '>>> ';
    if (!options.ps2) options.ps2 = '... ';
    if (!options.console) options.console = console;
    if (!options.readline) options.readline = require('readline');
    if (options.terminal === undefined) options.terminal = options.output.isTTY;
    if (options.histfile === undefined) options.histfile = path.join(cachedir, 'rapydscript-repl.history');
    if (options.baselib === undefined) options.baselib = read_baselib(options.lib_path);
    if (!options.enum_global) options.enum_global = enum_global;
        
    options.colored = (options.terminal) ? colored : (function (string) { return string; });
    options.historySize = options.history_size || 1000;
    return options;
}

function read_history(options) {
    if (options.histfile) {
        try {
            return fs.readFileSync(options.histfile, 'utf-8').split('\n');
        } catch (e) { return []; }
    }
}

function write_history(options, history) {
    if (options.histfile) {
        history = history.join('\n');
        try {
            return fs.writeFileSync(options.histfile, history, 'utf-8');
        } catch (e) {}
    }
}

// Completion {{{

function global_names(ctx, options) {
    try {
        var ans = vm.runInContext(options.enum_global, ctx);
        ans = ans.concat(all_keywords);
        ans.sort();
        var seen = {};
        ans.filter(function (item) { 
            if (Object.prototype.hasOwnProperty.call(seen, item)) return false;
            seen[item] = true;
            return true;
        });
        return ans;
    } catch(e) {
        console.log(e.stack || e.toString());
    }
    return [];
}

function object_names(obj, prefix) {
    if (obj === null || obj === undefined) return [];
    var groups = [], prefix_len = prefix.length, p;

    function prefix_filter(name) { return (prefix_len) ? (name.substr(0, prefix_len) === prefix) : true; }

    function add(o) {
        var items = Object.getOwnPropertyNames(o).filter(prefix_filter);
        if (items.length) groups.push(items);
    }

    if (typeof obj === 'object' || typeof obj === 'function') {
        add(obj);
        p = Object.getPrototypeOf(obj);
    } else p = obj.constructor ? obj.constructor.prototype : null; 

    // Walk the prototype chain
    try {
        var sentinel = 5;
        while (p !== null && sentinel > 0) {
            add(p);
            p = Object.getPrototypeOf(p);
            // Circular refs possible? Let's guard against that.
            sentinel--;
        }
    } catch (e) {
        // console.error("completion error walking prototype chain:" + e);
    }
    if (!groups.length) return [];
    var seen = {}, ans = [];
    function uniq(name) {
        if (Object.prototype.hasOwnProperty.call(seen, name)) return false;
        seen[name] = true;
        return true;
    }
    for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        group.sort();
        ans = ans.concat(group.filter(uniq));
        ans.push('');  // group separator

    }
    while (ans.length && ans[ans.length - 1] === '') ans.pop();
    return ans;
}

function prefix_matches(prefix, items) {
    var len = prefix.length;
    var ans = items.filter(function(item) { return item.substr(0, len) === prefix; });
    ans.sort();
    return ans;
}

function find_completions(line, ctx, options) {
    var t;
    try {
        t = RapydScript.tokenizer(line, '<repl>');
    } catch(e) { return []; }
    var tokens = [], token;
    while (true) {
        try {
            token = t();
        } catch (e) { return []; }
        if (token.type === 'eof') break;
        if (token.type === 'punc' && '(){},;:'.indexOf(token.value) > -1)
            tokens = [];
        tokens.push(token);
    }
    if (!tokens.length) {
        // New line or trailing space
        return [global_names(ctx, options), ''];
    }
    var last_tok = tokens[tokens.length - 1];
    if (last_tok.value === '.' || (last_tok.type === 'name' && RapydScript.IDENTIFIER_PAT.test(last_tok.value))) {
        last_tok = last_tok.value;
        if (last_tok === '.') {
            tokens.push({'value':''});
            last_tok = '';
        }
        if (tokens.length > 1 && tokens[tokens.length - 2].value === '.') {
            // A compound expression
            var prefix = '', result;
            tokens.slice(0, tokens.length - 2).forEach(function (tok) { prefix += tok.value; });
            if (prefix) {
                try {
                    result = vm.runInContext(prefix, ctx, {'displayErrors':false});
                } catch(e) { return []; }
                return [object_names(result, last_tok), last_tok];
            }
        } else {
            return [prefix_matches(last_tok, global_names(ctx, options)), last_tok];
        }
    }
    return [];
}
// }}}

module.exports = function(options) {
	var output_options = {'omit_baselib':true, 'write_name':false, 'private_scope':false, 'beautify':true};
    options = repl_defaults(options);
    options.completer = completer;
    var rl = options.readline.createInterface(options);
	var ps1 = options.colored(options.ps1, 'green');
	var ps2 = options.colored(options.ps2, 'yellow');
	var ctx = create_ctx(options.baselib, options.show_js, options.console);
    var buffer = [];
    var more = false;
    var LINE_CONTINUATION_CHARS = ':\\';
    var toplevel;
    var import_dirs = utils.get_import_dirs();

    options.console.log(options.colored('Welcome to the RapydScript REPL! Press Ctrl+C then Ctrl+D to quit.', 'green', true));
    if (options.show_js)
        options.console.log(options.colored('Use show_js=False to stop the REPL from showing the compiled JavaScript.', 'green', true));
    else
        options.console.log(options.colored('Use show_js=True to have the REPL show the compiled JavaScript before executing it.', 'green', true));
    options.console.log();

    function resetbuffer() { buffer = []; }

    function completer(line) {
        return find_completions(line, ctx, options);
    }

    function prompt() {
        var lw = '';
        if (more && buffer.length) {
            var prev_line = buffer[buffer.length - 1];
            if (prev_line.trimRight().substr(prev_line.length - 1) == ':') lw = '    ';
            prev_line = prev_line.match(/^\s+/);
            if (prev_line) lw += prev_line;
        }
        rl.setPrompt((more) ? ps2 : ps1);
        if (rl.sync_prompt) rl.prompt(lw);
        else {
            rl.prompt();
            if (lw) rl.write(lw);
        }
    }

    function runjs(js) {
        var result;
        if (vm.runInContext('show_js', ctx)) {
            options.console.log(options.colored('---------- Compiled JavaScript ---------', 'green', true));
            options.console.log(js);
            options.console.log(options.colored('---------- Running JavaScript ---------', 'green', true));
        }
        try {
            // Despite what the docs say node does not actually output any errors by itself
            // so, in case this bug is fixed later, we turn it off explicitly.
            result = vm.runInContext(js, ctx, {'filename':'<repl>', 'displayErrors':false});
        } catch(e) {
            if (e.stack) options.console.error(e.stack);
            else options.console.error(e.toString());
        }

        if (result !== undefined) {
            options.console.log(util.inspect(result, {'colors':options.terminal}));
        }
    }

    function compile_source(source, output_options) {
        var classes = (toplevel) ? toplevel.classes : undefined;
        try {
            toplevel = RapydScript.parse(source, {
                'filename':'<repl>',
                'basedir': process.cwd(),
                'libdir': options.imp_path,
                'import_dirs': import_dirs,
                'classes': classes
            });
        } catch(e) {
            if (e.is_eof && e.line == buffer.length && e.col > 0) return true;
            if (e.message && e.line !== undefined) options.console.log(e.line + ':' + e.col + ':' + e.message);
            else options.console.log(e.stack || e.toString());
            return false;
        }
        var output = RapydScript.OutputStream(output_options);
        toplevel.print(output);
        output = output.toString();
        if (classes) {
            var exports = {};
            toplevel.exports.forEach(function (name) { exports[name] = true; });
            Object.getOwnPropertyNames(classes).forEach(function (name) {
                if (!exports.hasOwnProperty(name) && !toplevel.classes.hasOwnProperty(name))
                    toplevel.classes[name] = classes[name];
            });
        }
        runjs(output);
        return false;
    }

    function push(line) {
        buffer.push(line);
        var ll = line.trimRight();
        if (ll && LINE_CONTINUATION_CHARS.indexOf(ll.substr(ll.length - 1)) > -1)
            return true;
        var source = buffer.join('\n');
        if (!source.trim()) { resetbuffer(); return false; }
        var incomplete = compile_source(source, output_options);
        if (!incomplete) resetbuffer();
        return incomplete;
    }

	rl.on('line', function(line) {
        if (more) {
            // We are in a block 
            var line_is_empty = !line.trimLeft();
            if (line_is_empty && buffer.length && !buffer[buffer.length - 1].trimLeft()) {
                // We have two empty lines, evaluate the block
                more = push(line.trimLeft());
            } else buffer.push(line);
        } else more = push(line);  // Not in a block, evaluate line
		prompt();
	})
	
	.on('close', function() {
		options.console.log('Bye!');
        if (rl.history) write_history(options, rl.history);
		process.exit(0);
	})

	.on('SIGINT', function() {
        rl.clearLine();
		options.console.log('Keyboard Interrupt');
        resetbuffer();
        more = false;
		prompt();
	})

	.on('SIGCONT', function() {
		prompt();
	});

    rl.history = read_history(options);
	prompt();
};
