package ru.sash.mechaniccheck;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.util.Base64;
import android.webkit.WebView;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Explicit SAF image selection only; no storage permissions or network and no original photo retained. */
final class AvatarFiles {
    static final String ROUTE="https://appassets.androidplatform.net/avatar-import";
    private static final int REQUEST=7201, MAX=10*1024*1024;
    private final Activity activity; private final WebView web;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService io=Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"avatar-io");t.setDaemon(true);return t;});
    private volatile ParcelFileDescriptor opened; private volatile boolean destroyed;
    private CancellationSignal signal; private boolean busy; private int generation;
    AvatarFiles(Activity a,WebView w){activity=a;web=w;}
    private boolean trusted(){return !destroyed&&BackupPolicy.INDEX.equals(web.getUrl());}
    void start(){if(!trusted()||busy)return;busy=true;generation++;Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("image/*");i.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/jpeg","image/png","image/webp"});i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,false);i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);try{activity.startActivityForResult(i,REQUEST);}catch(RuntimeException e){error("Не удалось открыть выбор фотографий.");}}
    boolean result(int request,int result,Intent data){
        if(request!=REQUEST)return false;
        if(!busy){error("Выбор фото отменён после перезапуска экрана. Выберите его заново.");return true;}
        if(result!=Activity.RESULT_OK){error("Выбор фотографии отменён.");return true;}
        Uri uri=data==null?null:data.getData();if(uri==null||!BackupPolicy.isContentUri(uri.toString())||!trusted()){error("Не удалось открыть выбранное фото.");return true;}
        final int run=generation;signal=new CancellationSignal();final CancellationSignal cancel=signal;
        main.postDelayed(()->{if(busy&&generation==run){generation++;error("Время чтения фото истекло. Попробуйте другой файл.");cancelIO();}},60000);
        io.submit(()->{try{
            ParcelFileDescriptor fd=activity.getContentResolver().openFileDescriptor(uri,"r",cancel);if(fd==null)throw new IOException();opened=fd;
            byte[] bytes;
            try(ParcelFileDescriptor.AutoCloseInputStream in=new ParcelFileDescriptor.AutoCloseInputStream(fd);ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] chunk=new byte[8192];int n,total=0;
                while((n=in.read(chunk))!=-1){if(Thread.currentThread().isInterrupted()||destroyed||cancel.isCanceled())throw new IOException();total+=n;if(total>MAX)throw new IOException();out.write(chunk,0,n);}if(fd.canDetectErrors())fd.checkError();bytes=out.toByteArray();
            }finally{opened=null;}
            String image=thumbnail(bytes);main.post(()->{if(!destroyed&&run==generation&&busy){busy=false;send("receiveImage",image);}});
        }catch(Exception|OutOfMemoryError e){main.post(()->{if(!destroyed&&run==generation)error("Не удалось обработать фото. Выберите JPEG, PNG или WebP до 10 МиБ.");});}});return true;
    }
    private static String thumbnail(byte[] data)throws Exception{
        BitmapFactory.Options o=new BitmapFactory.Options();o.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(data,0,data.length,o);
        if(o.outWidth<1||o.outHeight<1||(long)o.outWidth*o.outHeight>80000000L||!("image/jpeg".equals(o.outMimeType)||"image/png".equals(o.outMimeType)||"image/webp".equals(o.outMimeType)))throw new IOException();
        o.inSampleSize=1;while(Math.max(o.outWidth,o.outHeight)/o.inSampleSize>1024)o.inSampleSize*=2;o.inJustDecodeBounds=false;
        Bitmap src=BitmapFactory.decodeByteArray(data,0,data.length,o);if(src==null)throw new IOException();Bitmap oriented=null,cut=null,small=null;
        try{
            int orientation=1;try{orientation=new ExifInterface(new ByteArrayInputStream(data)).getAttributeInt(ExifInterface.TAG_ORIENTATION,1);}catch(IOException ignored){}
            Matrix matrix=new Matrix();switch(orientation){case 2:matrix.setScale(-1,1);break;case 3:matrix.setRotate(180);break;case 4:matrix.setScale(1,-1);break;case 5:matrix.setRotate(90);matrix.postScale(-1,1);break;case 6:matrix.setRotate(90);break;case 7:matrix.setRotate(-90);matrix.postScale(-1,1);break;case 8:matrix.setRotate(-90);break;default:break;}
            oriented=Bitmap.createBitmap(src,0,0,src.getWidth(),src.getHeight(),matrix,true);int size=Math.min(oriented.getWidth(),oriented.getHeight());cut=Bitmap.createBitmap(oriented,(oriented.getWidth()-size)/2,(oriented.getHeight()-size)/2,size,size);small=Bitmap.createBitmap(256,256,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(small);canvas.drawColor(Color.rgb(228,233,227));canvas.drawBitmap(cut,null,new android.graphics.Rect(0,0,256,256),new android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG));
            ByteArrayOutputStream out=new ByteArrayOutputStream();if(!small.compress(Bitmap.CompressFormat.JPEG,80,out))throw new IOException();String value="data:image/jpeg;base64,"+Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP);if(value.length()>100000)throw new IOException();return value;
        }finally{if(small!=null)small.recycle();if(cut!=null&&cut!=oriented&&cut!=src)cut.recycle();if(oriented!=null&&oriented!=src)oriented.recycle();src.recycle();}
    }
    private void send(String method,String value){if(trusted())web.evaluateJavascript("if(window.AvatarUI)window.AvatarUI."+method+"("+JSONObject.quote(value).replace("\u2028","\\u2028").replace("\u2029","\\u2029")+");",null);}
    private void error(String text){busy=false;send("onError",text);}
    private void cancelIO(){final ParcelFileDescriptor fd=opened;final CancellationSignal s=signal;Thread t=new Thread(()->{try{if(fd!=null)fd.close();}catch(IOException ignored){}if(s!=null)s.cancel();},"avatar-cancel");t.setDaemon(true);t.start();}
    void destroy(){destroyed=true;generation++;busy=false;main.removeCallbacksAndMessages(null);cancelIO();io.shutdownNow();}
}
