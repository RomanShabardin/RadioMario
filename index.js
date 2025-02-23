const { Client, GatewayIntentBits } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    getVoiceConnection,
} = require('@discordjs/voice');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { createReadStream } = require('fs');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

//const { prefix, token } = require('./config.json'); // УДАЛИТЬ

const token = process.env.TOKEN; // Читаем из переменной окружения
const prefix = process.env.PREFIX || '!'; // Читаем из переменной окружения, если не указано, то используем '!'

// Веб-сервер для проверки работы бота
app.get('/', (req, res) => {
    res.send('Бот работает!');
});

app.listen(port, () => {
    console.log(`Веб-сервер запущен на порту ${port}`);
});

// Настройка клиента Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// Глобальный объект для управления музыкой на разных серверах
const musicQueues = {};

client.once('ready', () => {
    console.log('Бот готов!');
});

client.on('messageCreate', async (message) => {
    if (!message.guild) return;

    const args = message.content.split(' ');

    // Функция для получения или создания очереди для сервера
    const getOrCreateQueue = (guildId) => {
        if (!musicQueues[guildId]) {
            musicQueues[guildId] = {
                audioPlayer: createAudioPlayer(),
                currentAudioResource: null,
                currentURL: null,
                repeatMode: false,
                repeatQueueMode: false,
                queue: [],
                originalQueue: [],
                isPlaying: false,
                lastMessageChannel: null,
                voiceConnection: null,
                reconnecting: false, // Флаг для предотвращения одновременных попыток переподключения
                cache: {},
            };

            musicQueues[guildId].audioPlayer.on(AudioPlayerStatus.Idle, async () => {
                console.log(`Аудиоплеер Idle на сервере ${guildId}`);
                await handleIdleState(guildId);
            });

            // Функция для переподключения
            const attemptReconnect = async () => {
                if (musicQueues[guildId].reconnecting) return;
                musicQueues[guildId].reconnecting = true;

                console.log(`Попытка переподключения к голосовому каналу на сервере ${guildId}...`);

                try {
                    musicQueues[guildId].voiceConnection = joinVoiceChannel({
                        channelId: message.member.voice.channel.id,
                        guildId: message.guild.id,
                        adapterCreator: message.guild.voiceAdapterCreator,
                        selfDeaf: false,
                    });

                    musicQueues[guildId].voiceConnection.subscribe(musicQueues[guildId].audioPlayer);
                    console.log(`Успешно переподключено к голосовому каналу на сервере ${guildId}.`);
                } catch (error) {
                    console.error(`Не удалось переподключиться к голосовому каналу на сервере ${guildId}:`, error);
                    // Повторная попытка через несколько секунд
                    setTimeout(attemptReconnect, 5000);
                } finally {
                    musicQueues[guildId].reconnecting = false;
                }
            };

            // Обработчики событий для voiceConnection
            musicQueues[guildId].voiceConnection = joinVoiceChannel({
                        channelId: message.member.voice.channel.id,
                        guildId: message.guild.id,
                        adapterCreator: message.guild.voiceAdapterCreator,
                        selfDeaf: false,
                    });

            musicQueues[guildId].voiceConnection.on('stateChange', (oldState, newState) => {
                console.log(`VoiceConnection changed from ${oldState.status} to ${newState.status} in guild ${guildId}.`);
                if (newState.status === VoiceConnectionStatus.Disconnected) {
                    console.log(`VoiceConnection disconnected in guild ${guildId}. Attempting to reconnect...`);
                    // Попытка переподключения
                    attemptReconnect();
                }
            });

            musicQueues[guildId].voiceConnection.on('error', (error) => {
                console.error(`Ошибка VoiceConnection на сервере ${guildId}:`, error);
                attemptReconnect(); // Попытка переподключения при ошибке
            });

            return musicQueues[guildId];
        }
        return musicQueues[guildId];
    };

    // Получаем или создаем очередь для текущего сервера
    const queueData = getOrCreateQueue(message.guild.id);
    const { audioPlayer, cache } = queueData;  // Добавляем cache

    if (message.content === '>Подключить') {
        if (message.member.voice.channel) {
            queueData.voiceConnection = joinVoiceChannel({
                channelId: message.member.voice.channel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfDeaf: false,
            });

            queueData.voiceConnection.on("stateChange", (oldState, newState) => {
                if (oldState.status === VoiceConnectionStatus.Ready && newState.status === VoiceConnectionStatus.Connecting) {
                    queueData.voiceConnection.configureNetworking();
                }
            });

            queueData.voiceConnection.subscribe(audioPlayer); // Подписываемся на audioPlayer

            message.channel.send(`Бот подключен к каналу ${message.member.voice.channel.name}`);
        } else {
            message.reply('Сначала зайди в голосовой канал!');
        }
    }


    if (args[0] === '>Поехали') {
        const url = args[1];
        if (url) {
            if (queueData.voiceConnection) {
                queueData.queue.push(url);
                queueData.originalQueue.push(url);
                message.channel.send(`Песня добавлена в очередь!`);

                if (!queueData.isPlaying) {
                    await playNextSong(message.guild.id, message);
                }
            } else {
                message.reply('Сначала подключитесь к голосовому каналу командой ">Подключить"');
            }
        } else {
            message.reply('Укажи ссылку на песню после команды >Поехали.');
        }
    }

    if (message.content === '>Повтор') {
        queueData.repeatMode = !queueData.repeatMode;
        message.channel.send(`Режим повтора ${queueData.repeatMode ? 'включён' : 'выключен'}`);
    }

    if (message.content === '>ПовторОчередь') {
        queueData.repeatQueueMode = !queueData.repeatQueueMode;
        message.channel.send(`Режим повтора всей очереди ${queueData.repeatQueueMode ? 'включён' : 'выключен'}`);
    }

    if (message.content === '>Пропустить') {
        if (queueData.queue.length > 0 || queueData.repeatQueueMode) {
            await playNextSong(message.guild.id, message);
        } else {
            message.channel.send('В очереди больше нет песен.');
        }
    }

    if (message.content === '>Очередь') {
        if (queueData.queue.length > 0) {
            message.channel.send(`Текущая очередь: ${queueData.queue.join(' ')}`);
        } else {
            message.channel.send('Очередь пуста.');
        }
    }

    queueData.lastMessageChannel = message.channel; // Обновляем канал для каждого сервера
});

client.on('guildCreate', (guild) => {
    console.log(`Бот присоединился к серверу ${guild.name}`);
});

client.on('guildDelete', (guild) => {
    console.log(`Бот покинул сервер ${guild.name}`);
});

async function playNextSong(guildId, message) {
    const queueData = musicQueues[guildId];
    if (!queueData) return;

    const { audioPlayer, repeatMode, repeatQueueMode, queue, originalQueue, voiceConnection, cache, lastMessageChannel } = queueData;  // Добавляем cache

    if (queue.length === 0) {
        if (repeatQueueMode) {
            queueData.queue = [...originalQueue];
        } else {
            queueData.isPlaying = false;
            if (lastMessageChannel) lastMessageChannel.send('Очередь пуста.');
            return;
        }
    }

    const url = queue.shift();
    queueData.currentURL = url; // Сохраняем текущий URL
    const tempDir = path.resolve(__dirname, 'temp');
    const tempFilePath = path.resolve(tempDir, `${Date.now()}-${path.basename(url.split('?')[0])}`);

    try {
        await fs.ensureDir(tempDir); // Убедимся, что каталог temp существует

        // Проверка, есть ли файл в кэше
        if (!cache[url]) { // Если нет в кэше, то скачиваем
            console.log(`Загружаем файл с URL: ${url}`);
            await downloadFile(url, tempFilePath);
            console.log(`Файл скачан и сохранен по пути: ${tempFilePath}`);
            cache[url] = tempFilePath; // Кэшируем путь к файлу
        } else {
             console.log('Использование кэша для аудиофайла.');
        }

        queueData.currentAudioResource = createAudioResource(createReadStream(cache[url]));
        audioPlayer.play(queueData.currentAudioResource);

        audioPlayer.on('error', error => {
            console.error('Ошибка воспроизведения:', error);
            if (lastMessageChannel) lastMessageChannel.send('Ошибка воспроизведения.');
        });


        queueData.isPlaying = true;
        if (lastMessageChannel) lastMessageChannel.send(`Начинаем воспроизведение: ${url}`);
    } catch (error) {
        console.error('Ошибка при загрузке аудиофайла:', error);
        if (lastMessageChannel) lastMessageChannel.send('Ошибка при загрузке аудиофайла.');
        await playNextSong(guildId, message);
    }
}

async function handleIdleState(guildId) {
    const queueData = musicQueues[guildId];
    if (!queueData) return;

    const { audioPlayer, repeatMode, repeatQueueMode, queue, originalQueue, voiceConnection, cache, lastMessageChannel, currentURL } = queueData;

    if (repeatMode && currentURL) {
        // Если включен режим повтора, воспроизводим текущий трек заново
        console.log(`Повторяем трек на сервере ${guildId}`);
        if (cache[currentURL]) {
             queueData.currentAudioResource = createAudioResource(createReadStream(cache[currentURL]));
             audioPlayer.play(queueData.currentAudioResource);
        }

    } else if (repeatQueueMode && queue.length === 0) {
        // Если включен режим повтора очереди и очередь пуста, восстанавливаем очередь и играем следующий трек
        console.log(`Повторяем очередь на сервере ${guildId}`);
        queueData.queue = [...originalQueue];
        await playNextSong(guildId);
    } else {
        // Если нет режимов повтора, играем следующий трек
        console.log(`Играем следующий трек на сервере ${guildId}`);
        await playNextSong(guildId);
    }
}

async function downloadFile(url, dest) {
    console.log(`Попытка загрузить файл с URL: ${url}`);

    const writer = fs.createWriteStream(dest);

    try {
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
    } catch (error) {
        console.error('AxiosError:', error.message);
        throw error;
    }
}

client.on('error', error => {
    console.error('Произошла ошибка:', error);
    //if (lastMessageChannel) lastMessageChannel.send('Произошла ошибка. Переподключаемся...');
});

// Переподключение при сбое
client.on('shardDisconnect', (event, id) => {
    console.log(`Shard ${id} отключен. Переподключение...`);
    client.login(token);
});

client.login(token);
