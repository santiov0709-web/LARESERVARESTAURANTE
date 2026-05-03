const fs = require('fs');
const pdf = require('pdf-parse');

let dataBuffer = fs.readFileSync('Mi carta (1).pdf');

pdf(dataBuffer).then(function(data) {
    fs.writeFileSync('temp_menu.txt', data.text);
    console.log('Success, extracted', data.text.length, 'characters.');
}).catch(function(err) {
    console.error('Error extracting PDF:', err);
});
