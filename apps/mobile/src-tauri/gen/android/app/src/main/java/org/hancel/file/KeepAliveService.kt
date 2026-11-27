package org.hancel.file

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Minimal foreground service for the CrossFile mobile shell.
 *
 * Why it exists: Android may freeze/kill a backgrounded app while a WebRTC data
 * channel is still transferring. A `dataSync` foreground service raises the
 * process priority enough that a locked screen / app switch does not stop the
 * transfer, and it shows an ongoing notification (required by Android).
 *
 * Started by [MainActivity.onCreate] and stopped in `onDestroy` when the activity
 * really goes away. No JS bridge is needed: the transfer runs inside the WebView
 * owned by this process, so "service running == process protected".
 *
 * Android 14+ requires the `FOREGROUND_SERVICE_DATA_SYNC` permission and the
 * `android:foregroundServiceType="dataSync"` manifest attribute; Android 13+
 * hides the notification until the user grants POST_NOTIFICATIONS (the service
 * still runs).
 */
class KeepAliveService : Service() {
    companion object {
        private const val CHANNEL_ID = "crossfile-transfer"
        private const val NOTIFICATION_ID = 47001

        fun start(context: Context) {
            val intent = Intent(context, KeepAliveService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, KeepAliveService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CrossFile")
            .setContentText("正在传输文件，请保持应用运行")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                "文件传输",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "传输期间保持 CrossFile 在后台运行"
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
        }
    }
}
