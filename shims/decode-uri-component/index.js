'use strict';
// decode-uri-component 0.2.2's API and output, in linear time (GHSA-vcc3-ghjq-m6fr).
// 0.2.2 retried every way of splitting a run of malformed escapes, so 400 of them
// took seconds. Here each position tries at most four escapes (the longest UTF-8
// sequence), keeps what decodes and leaves the rest as typed. The surrounding logic
// (the BOM and %C2 replacements, '+' as space) is 0.2.2's own; see NOTICE.

var multiMatcher = new RegExp('(%[a-f0-9]{2})+', 'gi');

function decodeRun(run) {
	var tokens = run.match(/%[a-f0-9]{2}/gi) || [];
	var out = '';
	for (var i = 0; i < tokens.length; ) {
		var decoded = null;
		for (var len = Math.min(4, tokens.length - i); len >= 1 && decoded === null; len--) {
			try {
				decoded = decodeURIComponent(tokens.slice(i, i + len).join(''));
				i += len;
			} catch (err) {
				// shorter next
			}
		}
		if (decoded === null) {
			out += tokens[i];
			i++;
		} else {
			out += decoded;
		}
	}
	return out;
}

function customDecodeURIComponent(input) {
	var replaceMap = {
		'%FE%FF': '��',
		'%FF%FE': '��'
	};

	var match = multiMatcher.exec(input);
	while (match) {
		try {
			replaceMap[match[0]] = decodeURIComponent(match[0]);
		} catch (err) {
			var result = decodeRun(match[0]);
			if (result !== match[0]) {
				replaceMap[match[0]] = result;
			}
		}
		match = multiMatcher.exec(input);
	}

	replaceMap['%C2'] = '�';

	var entries = Object.keys(replaceMap);
	for (var i = 0; i < entries.length; i++) {
		var key = entries[i];
		input = input.split(key).join(replaceMap[key]);
	}
	return input;
}

module.exports = function (encodedURI) {
	if (typeof encodedURI !== 'string') {
		throw new TypeError('Expected `encodedURI` to be of type `string`, got `' + typeof encodedURI + '`');
	}
	try {
		encodedURI = encodedURI.replace(/\+/g, ' ');
		return decodeURIComponent(encodedURI);
	} catch (err) {
		return customDecodeURIComponent(encodedURI);
	}
};
