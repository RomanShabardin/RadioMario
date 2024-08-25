



const { Client, Intents } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { createReadStream } = require('fs');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;





const {
    prefix,
    token,
   } = require('./config.json');




// Веб-сервер для Glitch
app.get('/', (req, res) => {
res.send('Бот работает!');
});

app.listen(port, () => {
console.log(`Веб-сервер запущен на порту ${port}`);
});

// Настройка Discord бота
const client = new Client({
intents: [
Intents.FLAGS.GUILDS,
Intents.FLAGS.GUILD_VOICE_STATES,
Intents.FLAGS.GUILD_MESSAGES,
Intents.FLAGS.MESSAGE_CONTENT,
],
});

const audioPlayer = createAudioPlayer();
let currentAudioResource = null;
let repeatMode = false;
let repeatQueueMode = false;
let queue = [];
let originalQueue = [];
let isPlaying = false;
let lastMessageChannel = null;
const cache = {}; // Кэш для путей к файлам

// Опыт за секунду и множители
const BASE_EXP_PER_SECOND = 5;
const MULTIPLIERS = {
TEXT: 1.5,
GOOD_SOUND: 1.5,
MUSIC_NOTES: 2,
CORRECTION: 1.5,
PERFORMANCE: 2,
};

// Вычисление опыта
function calculateExperience(durationInSeconds, multipliers) {
let totalMultiplier = 1;
for (const multiplier of multipliers) {
totalMultiplier *= MULTIPLIERS[multiplier];
}
return BASE_EXP_PER_SECOND * durationInSeconds * totalMultiplier;
}

client.once('ready', () => {
console.log('Бот готов!');
});

client.on('messageCreate', async (message) => {
if (!message.guild) return;

const args = message.content.split(' ');

if (args[0] === '>Поехали') {
const url = args.length > 1 ? args[1] : null;
if (url) {
if (message.member.voice.channel) {
const connection = joinVoiceChannel({
channelId: message.member.voice.channel.id,
guildId: message.guild.id,
adapterCreator: message.guild.voiceAdapterCreator,
selfDeaf: false,
});

queue.push(url);
originalQueue.push(url);
message.channel.send(`Песня добавлена в очередь!`);

connection.on("stateChange", (oldState, newState) => {
if (oldState.status === VoiceConnectionStatus.Ready && newState.status === VoiceConnectionStatus.Connecting) {
connection.configureNetworking();
}
});

if (!isPlaying) {
await playNextSong(connection, message);
}
} else {
message.reply('Сначала зайди в голосовой канал!');
}
} else {
message.reply('Укажи ссылку на песню после команды >Поехали.');
}
}

if (message.content === '>Повтор') {
repeatMode = !repeatMode;
message.channel.send(`Режим повтора ${repeatMode ? 'включён' : 'выключен'}`);
}

if (message.content === '>ПовторОчередь') {
repeatQueueMode = !repeatQueueMode;
message.channel.send(`Режим повтора всей очереди ${repeatQueueMode ? 'включён' : 'выключен'}`);
}

if (message.content === '>Пропустить') {
if (queue.length > 0 || repeatQueueMode) {
await playNextSong(null, message);
} else {
message.channel.send('В очереди больше нет песен.');
}
}

if (message.content === '>Очередь') {
if (queue.length > 0) {
message.channel.send(`Текущая очередь: ${queue.join(' ')}`);
} else {
message.channel.send('Очередь пуста.');
}
}

lastMessageChannel = message.channel;
});

async function playNextSong(connection, message) {
if (queue.length === 0) {
if (repeatQueueMode) {
queue = [...originalQueue];
} else {
isPlaying = false;
if (lastMessageChannel) lastMessageChannel.send('Очередь пуста.');
return;
}
}

const url = queue.shift();
const tempDir = path.resolve(__dirname, 'temp');
const tempFilePath = path.resolve(tempDir, `${Date.now()}-${path.basename(url.split('?')[0])}`);

try {
await fs.ensureDir(tempDir); // Убедимся, что каталог temp существует

// Проверка, есть ли файл в кэше
if (cache[url]) {
console.log('Использование кэша для аудиофайла.');
currentAudioResource = createAudioResource(createReadStream(cache[url]));
} else {
console.log(`Загружаем файл с URL: ${url}`);
await downloadFile(url, tempFilePath);
console.log(`Файл скачан и сохранен по пути: ${tempFilePath}`);
cache[url] = tempFilePath; // Кэшируем путь к файлу
currentAudioResource = createAudioResource(createReadStream(tempFilePath));
}

audioPlayer.play(currentAudioResource);

audioPlayer.once('stateChange', async (oldState, newState) => {
console.log(`Аудиоплеер изменил состояние: ${oldState.status} -> ${newState.status}`);
if (newState.status === AudioPlayerStatus.Idle) {
const duration = currentAudioResource.inputStream.time / 1000; // Время в секундах
const multipliers = ['TEXT', 'GOOD_SOUND']; // Пример множителей, которые будут браться из ваших данных
const exp = calculateExperience(duration, multipliers);
console.log(`Вы заработали ${exp} опыта за воспроизведение песни.`);
await playNextSong(connection, message);
}
});

audioPlayer.on('error', error => {
console.error('Ошибка воспроизведения:', error);
if (lastMessageChannel) lastMessageChannel.send('Ошибка воспроизведения.');
});

if (connection) {
connection.subscribe(audioPlayer);
}

isPlaying = true;
if (lastMessageChannel) lastMessageChannel.send(`Начинаем воспроизведение: ${url}`);
} catch (error) {
console.error('Ошибка при загрузке аудиофайла:', error);
if (lastMessageChannel) lastMessageChannel.send('Ошибка при загрузке аудиофайла.');
await playNextSong(connection, message);
}
}

async function downloadFile(url, dest) {
const writer = fs.createWriteStream(dest);

const response = await axios({
url,
method: 'GET',
responseType: 'stream',
headers: {
'User-Agent': 'Mozilla/5.0'
},
});

response.data.pipe(writer);

return new Promise((resolve, reject) => {
writer.on('finish', resolve);
writer.on('error', reject);
});
}

audioPlayer.on(AudioPlayerStatus.Idle, () => {
if (repeatMode && currentAudioResource) {
const url = Object.keys(cache)[0]; // Возьмем первый файл из кэша в качестве текущего
currentAudioResource = createAudioResource(createReadStream(cache[url])); // Создаем новый аудиоресурс для каждого повторения
[]
audioPlayer.play(currentAudioResource);
}
});

client.on('error', error => {
console.error('Произошла ошибка:', error);
if (lastMessageChannel) lastMessageChannel.send('Произошла ошибка. Переподключаемся...');
});

// Переподключение при сбое
client.on('shardDisconnect', (event, id) => {
console.log(`Shard ${id} отключен. Переподключение...`);
client.login('YOUR_BOT_TOKEN');
});











client.login(token);