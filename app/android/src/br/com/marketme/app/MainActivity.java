package br.com.marketme.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Casca nativa mínima do MarketMe: um WebView em tela cheia que carrega a
 * SPA empacotada em assets/www. Sem AndroidX/Gradle de propósito — o APK é
 * montado direto com aapt + dx + apksigner (ver build.sh).
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE_CHOOSER = 2;
    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        // Com targetSdk 35 o Android 15 força edge-to-edge; isto faz o
        // sistema aplicar as barras (status/gestos) como padding em vez
        // de desenhar o conteúdo por baixo delas.
        webView.setFitsSystemWindows(true);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);            // localStorage (configurações do app)
        s.setAllowFileAccess(true);
        // A SPA roda em file:// e chama a API em http://<servidor>:3000.
        // Sem isto o WebView bloquearia o fetch por CORS/conteúdo misto.
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);

        // Ponte nativa mínima: o botão "Sair" (menu escondido do PDV)
        // encerra o aplicativo de verdade via MMNative.exitApp()
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void exitApp() {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (Build.VERSION.SDK_INT >= 21) finishAndRemoveTask();
                        else finish();
                    }
                });
            }
        }, "MMNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // navegação fica dentro do app
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            // Sem isto, <input type="file"> (usado para escolher a logo
            // nas Configurações) não abre nada no WebView do Android.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                              FileChooserParams params) {
                pendingFileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "Escolher logo"), REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    pendingFileCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (pendingFileCallback == null) return;
            Uri[] result = null;
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[] { data.getData() };
            }
            pendingFileCallback.onReceiveValue(result);
            pendingFileCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
