# Guida Utente - DbCheck Composer

Questa guida spiega come usare DbCheck Composer per creare e lanciare regressioni DBCheck senza scrivere codice Java hardcoded.

## Obiettivo

DbCheck Composer aiuta il tester a:

- autenticarsi su Vulki usando le API esistenti;
- recuperare o incollare i parametri di elaborazione;
- creare una configurazione di regressione dinamica;
- scegliere tabelle e dati attesi;
- preparare YAML DBCheck o prompt per chi deve implementarli nel backend;
- lanciare la regressione e leggere il risultato.

L'app non sostituisce il motore di regressione. Organizza i dati e usa le API backend gia esistenti.

## Avvio

Nel progetto:

```bat
start-app.bat
```

L'app parte sempre su:

```text
http://localhost:8095
```

Se la porta `8095` e gia occupata, il launcher si ferma con errore. Chiudere l'altro processo e rilanciare.

## Prerequisiti

Prima di usare l'app servono:

- Vulki/AKN in esecuzione, per esempio su `http://localhost:8080/akeron`;
- un `dbId` valido, per esempio `TP_ORACOLI_SVILUPPO`;
- utente e password Vulki validi;
- se si vuole leggere automaticamente il log Docker, Docker CLI disponibile sulla macchina;
- se si vuole leggere un log locale, percorso del file `akeron.log`, per esempio `C:\sviluppo\wildfly-java\log\vulki\akeron.log`;
- backend AKN/TP aggiornato con le API DBCheck dinamiche.

## Flusso consigliato

Il flusso standard e:

1. Autenticazione
2. Template
3. Tabelle
4. Prompt o YAML
5. Run
6. Risultato

## 1. Autenticazione

Compilare:

- Host Vulki, esempio `http://localhost:8080/akeron`
- Database, esempio `TP_ORACOLI_SVILUPPO`
- Utente
- Password

Premere il pulsante di autenticazione.

Se va a buon fine, l'app salva localmente il profilo riuscito, cosi la volta successiva host, utente e dbId possono essere riusati.

Se fallisce:

- verificare host e porta;
- verificare credenziali;
- verificare che il backend sia raggiungibile;
- verificare che la chiamata arrivi al backend.

Senza autenticazione non si deve avanzare negli step successivi.

## 2. Template

In questo step si sceglie come creare la regressione.

### Template Import

Usare questa strada quando si parte da uno script legacy del repository `regression-test`.

Esempio:

```text
C:\sviluppo\devgit\regression-test\scriptSql\ic_01\DONE\CAL_PREMI_STEP_FORMULA_TP_8668_001.sql
```

```text
da https://akn-gitlab.akeron.com/devops/regressiontest/-/blob/master/scriptSql/ic_01/DONE/CAL_PREMI_STEP_FORMULA_TP_8668_001.sql?ref_type=heads
```
Il template import serve per casi come `CALCOLO_PREMI`, dove esistono gia script SQL con:

- insert in `CONFIG_REGRTEST_ELAB`;
- creazione tabelle oracolo;
- insert dei dati attesi;
- task legacy gia conosciuto.

Azioni tipiche:

- scegliere tipo sorgente `TP SQL`;
- indicare o caricare lo script SQL;
- premere parse;
- verificare che i parametri e le tabelle siano riconosciuti.

### Dynamic DBCheck

Usare questa strada quando si vuole testare il nuovo comportamento DBCheck dinamico.

Campi importanti:

- `OID`: identificativo della configurazione, esempio `SCORECARD_DBCHECK`;
- `TASK`: task da salvare in `CONFIG_REGRTEST_ELAB`, spesso uguale a `OID`;
- `e.codElab`: codice elaborazione da passare a TP, esempio `SCORECARD_DBCHECK`;
- `dbcheck.catalogResources`: lista YAML catalogo, separata da virgole;
- `dbcheck.regressionResource`: YAML della regressione;
- `dbcheck.runtime.*`: valori runtime usati dalla regressione;
- `dbcheck.expected.*`: valori attesi usati dagli assert.

Esempio:

```properties
e.codElab=SCORECARD_DBCHECK
dbcheck.catalogResources=generated-applicativo/beneficiari.yaml, generated-applicativo/misure-dati-kpi-qnt.yaml
dbcheck.regressionResource=scorecard/scorecard-regression.yaml
dbcheck.runtime.payeeId=12034
dbcheck.runtime.codMisura=KPI_SALES_Q1
dbcheck.runtime.executionId=SC_2026_04_27_01
dbcheck.expected.expectedRows=1
dbcheck.expected.expectedValue=87.50
dbcheck.expected.expectedTolerance=0.01
```

Se i file YAML non esistono ancora nel backend, la validazione resta rossa. In quel caso il tester puo comunque generare un prompt BE da consegnare a uno sviluppatore.

## Recupero parametri da log

Per molti test i parametri corretti arrivano dal log Vulki.

Nel documento operativo viene indicato di cercare:

```text
STAMPA PARAMETRI: INIZIO
```

DbCheck Composer supporta due modi:

- lettura da Docker log;
- lettura da file locale `akeron.log`.

Per `CALCOLO_PREMI`, i parametri utili possono trovarsi in:

```text
C:\sviluppo\wildfly-java\log\vulki\akeron.log
```

Dopo il caricamento, premere parse e verificare che campi come `e.codElab`, `e.dbId`, `OID_CONTRATTO_LIST`, `DATA_CALCOLO` e altri parametri specifici siano presenti.

## 3. Tabelle

Lo step Tabelle serve per organizzare quali dati devono essere controllati.

In modalita `TP SQL`, l'app prova a ricavare le tabelle dallo script SQL importato.

Esempi di tabelle:

- tabella reale, esempio `CONTRATTO`;
- tabella oracolo, esempio `CONTRATTO_CONF_ORACOLO`;
- righe attese copiate dallo script.

Il tester deve verificare:

- che le tabelle siano coerenti con lo scenario;
- che gli assert siano davvero collegati al caso che si vuole proteggere;
- che non siano stati importati dati troppo generici o non pertinenti.

In modalita Dynamic DBCheck, le tabelle dipendono dai catalog YAML disponibili. Se il catalogo non esiste, la validazione resta rossa e serve generare il prompt backend.

## 4. Prompt BE o YAML

Quando i YAML necessari non esistono, usare `Generate BE Prompt`.

Il prompt serve per chiedere a uno sviluppatore o a Codex CLI/IDE di implementare:

- dataset catalog YAML;
- regression YAML;
- mapping dei parametri runtime;
- assert dei dati attesi;
- eventuali test backend.

Dopo il click, l'app copia il prompt negli appunti e mostra una notifica.

Il tester non deve scrivere codice. Deve descrivere bene:

- scenario funzionale;
- input principali;
- tabelle coinvolte;
- risultati attesi;
- valori numerici reali;
- payee, contract, incentive plan o altri identificativi utili.

## 5. Run

Lo step Run lancia la regressione secondo il modo scelto nel template.

Modalita comuni:

- `Start`: run diretto;
- `Start schedule`: schedulazione tramite backend.

Per Dynamic DBCheck schedulato, il backend deve:

- inserire o aggiornare `dbo.CONFIG_REGRTEST_ELAB`;
- schedulare `REGR_TEST`;
- passare `oidScheduler` uguale all'OID della configurazione;
- far arrivare TP al task dinamico DBCheck.

La data del risultato deve usare il formato:

```text
yyyy_MM_dd
```

Esempio:

```text
2026_04_27
```

## 6. Risultato

Il risultato puo contenere:

- esito legacy;
- esito DBCheck;
- messaggi di errore;
- check falliti.

Se il risultato mostra:

```text
legacyOutcome = NON_TROVATO
dbCheckOutcome = null
```

significa che il backend non ha trovato il risultato legacy e non ha scritto snapshot DBCheck. Le cause piu comuni sono:

- riga mancante in `dbo.CONFIG_REGRTEST_ELAB`;
- OID sbagliato;
- task non instradato verso DBCheck dinamico;
- YAML mancanti;
- elaborazione non partita;
- ricerca risultato con data sbagliata.

Verifica DB consigliata:

```sql
SELECT *
FROM dbo.CONFIG_REGRTEST_ELAB
WHERE OID = 'SCORECARD_DBCHECK';
```

## Caso pratico: Scorecard DBCheck

Obiettivo: verificare che il valore calcolato per una KPI quantitativa di Scorecard non regredisca.

Passi:

1. Autenticarsi su Vulki.
2. Scegliere `Dynamic DBCheck`.
3. Impostare `OID` e `TASK`, esempio `SCORECARD_DBCHECK`.
4. Inserire cataloghi:

```text
generated-applicativo/beneficiari.yaml, generated-applicativo/misure-dati-kpi-qnt.yaml
```

5. Inserire regression resource:

```text
scorecard/scorecard-regression.yaml
```

6. Inserire parametri runtime, per esempio:

```properties
dbcheck.runtime.payeeId=12034
dbcheck.runtime.codMisura=KPI_SALES_Q1
dbcheck.runtime.executionId=SC_2026_04_27_01
```

7. Inserire valori attesi:

```properties
dbcheck.expected.expectedRows=1
dbcheck.expected.expectedValue=87.50
dbcheck.expected.expectedTolerance=0.01
```

8. Se validazione e verde, lanciare `Start schedule`.
9. Se validazione e rossa per YAML mancanti, generare il prompt BE.

## Esempio completo: TP-8912 Scorecard DBCheck

Questo esempio mostra cosa inserire in DbCheck Composer per creare il primo caso Scorecard dinamico collegato a `TP-8912`.

> Nota: i valori sotto sono realistici come struttura, ma gli identificativi devono essere sostituiti con valori presenti nel database di test.

### Dati scenario

Obiettivo funzionale:

- calcolare una Scorecard con KPI quantitativa;
- verificare il valore registrato in `MISURE_DATI_KPI_QNT`;
- controllare che target/consuntivo non regrediscano dopo modifiche applicative.

Valori esempio:

```text
dbId: TP_ORACOLI_SVILUPPO
OID/TASK: SCORECARD_DBCHECK
payeeId: 12034
codMisura: KPI_SALES_Q1
executionId: SC_2026_04_27_01
expectedRows: 1
expectedValue: 87.50
expectedTolerance: 0.01
```

### Campi da inserire in Template step

Creation path:

```text
Dynamic DBCheck
```

Generic config:

```text
Draft name: TP-8912 Scorecard KPI QNT
OID: SCORECARD_DBCHECK
TASK: SCORECARD_DBCHECK
Run mode: Start schedule
```

Dynamic DBCheck config:

```properties
e.codElab=SCORECARD_DBCHECK
dbcheck.catalogResources=generated-applicativo/beneficiari.yaml, generated-applicativo/misure-dati-kpi-qnt.yaml
dbcheck.regressionResource=scorecard/scorecard-regression.yaml
dbcheck.runtime.payeeId=12034
dbcheck.runtime.codMisura=KPI_SALES_Q1
dbcheck.runtime.executionId=SC_2026_04_27_01
dbcheck.expected.expectedRows=1
dbcheck.expected.expectedValue=87.50
dbcheck.expected.expectedTolerance=0.01
```

### Cosa deve salvare AKN in CONFIG_REGRTEST_ELAB

Dopo `Start schedule`, verificare:

```sql
SELECT OID, TASK, FLAG_ATTIVO, ORDINE, UTENTE, PARAMETRI
FROM dbo.CONFIG_REGRTEST_ELAB
WHERE OID = 'SCORECARD_DBCHECK';
```

Risultato atteso:

```text
OID = SCORECARD_DBCHECK
TASK = SCORECARD_DBCHECK
FLAG_ATTIVO = 1
PARAMETRI contiene e.codElab=SCORECARD_DBCHECK
PARAMETRI contiene dbcheck.catalogResources=...
PARAMETRI contiene dbcheck.regressionResource=...
PARAMETRI contiene dbcheck.runtime.*
PARAMETRI contiene dbcheck.expected.*
```

La schedulazione deve invece partire come wrapper:

```text
e.codElab=REGR_TEST
e.elabClassName=com.akeron.regressiontest.RegressionTestElaboration
oidScheduler=SCORECARD_DBCHECK
```

Questo e corretto: `REGR_TEST` parte come contenitore, poi TP legge `CONFIG_REGRTEST_ELAB` e instrada al task dinamico.

### Catalog YAML TP-8912: beneficiari.yaml

Risorsa TP:

```yaml
datasets:
  beneficiari:
    source:
      type: table
      name: BENEFICIARI
    fields:
      id:
        column: ID
        type: integer
        operators: [eq, neq, gt, gte, lt, lte, in, isNull, isNotNull]
```

### Catalog YAML TP-8912: misure-dati-kpi-qnt.yaml

Risorsa TP:

```yaml
datasets:
  misure_dati_kpi_qnt:
    source:
      type: table
      name: MISURE_DATI_KPI_QNT
    fields:
      payeeId:
        column: COD_ATTRIBUTO1
        type: integer
        operators: [eq, neq, gt, gte, lt, lte, in, isNull, isNotNull]
      codMisura:
        column: OID_MISURA
        type: string
        operators: [eq, neq, in, isNull, isNotNull]
      executionId:
        column: OID_BOOK_STEP
        type: string
        operators: [eq, neq, in, isNull, isNotNull]
      valore:
        column: VALORE
        type: decimal
        operators: [eq, neq, gt, gte, lt, lte, isNull, isNotNull]
```

### Regression YAML TP-8912

Risorsa TP:

```yaml
dbChecks:
  - name: scorecard_non_regression_count
    dataset: misure_dati_kpi_qnt
    filter:
      eq:
        payeeId: ${payeeId}
        codMisura: ${codMisura}
        executionId: ${executionId}
    assert:
      count: ${expectedRows}
  - name: scorecard_non_regression_values
    dataset: misure_dati_kpi_qnt
    filter:
      eq:
        payeeId: ${payeeId}
        codMisura: ${codMisura}
        executionId: ${executionId}
    assert:
      firstRowEquals:
        valore: ${expectedValue}
```

Nota: `expectedTolerance` e disponibile come parametro runtime/expected per evoluzioni del DSL, ma il YAML attuale confronta `valore` con `expectedValue`.

### Prompt BE da generare se YAML mancanti

Se la validazione resta rossa per catalogo o regression resource mancante, generare un prompt con questa intenzione:

```text
Implementare DBCheck dinamico SCORECARD_DBCHECK in TP.

Jira: TP-8912
Scenario: Scorecard KPI quantitativa, controllo valore target/consuntivo in MISURE_DATI_KPI_QNT.

Catalog resources richieste:
- generated-applicativo/beneficiari.yaml
- generated-applicativo/misure-dati-kpi-qnt.yaml

Regression resource:
- scorecard/scorecard-regression.yaml

Runtime:
- payeeId
- codMisura
- executionId

Expected:
- expectedRows = 1
- expectedValue = 87.50
- expectedTolerance = 0.01

Il test deve essere eseguito senza creare una nuova recipe Java hardcoded.
Deve usare ConfiguredDynamicDbCheckRecipe e RTDbCheckDynamicTask.
```

### Output atteso dopo run

Nel risultato strutturato:

```text
taskCode = REGR_TEST
configOid/resultOid = SCORECARD_DBCHECK
dbCheckOutcome = SUCCESSO
failedChecks = []
```

Se fallisce:

- `dbCheckOutcome = ERROR`: controllare dettagli check falliti;
- `dbCheckOutcome = null`: TP non ha scritto snapshot DBCheck;
- `legacyOutcome = NON_TROVATO`: puo essere normale per dynamic-only, ma non deve impedire DBCheck se snapshot esiste;
- riga mancante in `dbo.CONFIG_REGRTEST_ELAB`: problema AKN upsert/config OID;
- YAML non trovato: problema risorsa TP.

## Caso pratico: CALCOLO_PREMI da TP SQL

Obiettivo: retestare un caso misto legacy + nuova logica DBCheck partendo da uno script esistente.

Script di riferimento:

```text
C:\sviluppo\devgit\regression-test\scriptSql\ic_01\DONE\CAL_PREMI_STEP_FORMULA_TP_8668_001.sql
```

Passi:

1. Autenticarsi su Vulki.
2. Scegliere `Template Import`.
3. Scegliere sorgente `TP SQL`.
4. Caricare o indicare lo script.
5. Caricare i parametri da `akeron.log` se servono parametri runtime aggiornati.
6. Premere parse.
7. Verificare nello step Tabelle che le tabelle importate siano corrette.
8. Controllare i valori attesi.
9. Lanciare la regressione.
10. Controllare risultato legacy e DBCheck.

## Quando la validazione e rossa

Rosso non significa sempre errore del tester.

Puo significare:

- YAML catalogo non ancora presente nel backend;
- YAML regressione non ancora presente;
- API catalogo non disponibile;
- fallback locale usato al posto della validazione backend;
- parametri obbligatori mancanti.

Se mancano YAML o implementazione backend, usare `Generate BE Prompt`.

## Regole pratiche per tester

- Usare dati reali e piccoli, non dataset troppo grandi.
- Salvare OID leggibili, per esempio `SCORECARD_DBCHECK` o `CALCOLO_PREMI_STEP_FORMULA_TP_8668`.
- Non cambiare OID dopo aver lanciato, altrimenti il risultato puo non essere trovato.
- Verificare sempre il `dbId`.
- Usare `yyyy_MM_dd` per la data risultato.
- Se si parte da script legacy, importare prima lo script e poi correggere solo i dati necessari.
- Se si crea un nuovo scenario senza YAML, generare prompt BE invece di forzare il run.

## Checklist prima del lancio

- Autenticazione verde.
- `dbId` corretto.
- OID corretto.
- Parametri elaborazione presenti.
- Tabelle/assert controllati.
- YAML validi o prompt BE generato.
- Modalita run corretta.
- Backend AKN/TP aggiornato.
