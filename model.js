// this is the main bit of the recipe shopping app with referral links
require('dotenv').config({
    path: require('find-config')('.env')
});


const { PineconeStore } = require("@langchain/community/vectorstores/pinecone");
const { OpenAIEmbeddings, ChatOpenAI } = require("@langchain/openai");
const { formatDocumentsAsString } = require("langchain/util/document");
const { PromptTemplate } = require("@langchain/core/prompts");
const { StringOutputParser } = require("@langchain/core/output_parsers");
const { RunnableSequence } = require("@langchain/core/runnables");
const { BufferWindowMemory } = require("langchain/memory");
const { StructuredOutputParser } = require("langchain/output_parsers");
const { z } = require("zod");
const fs = require('fs/promises');
const path = require('path');
const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { Pinecone } =  require("@pinecone-database/pinecone");
const { ChatMessageHistory } = require("langchain/memory");
const { chromium } = require('playwright');

const { EPubLoader } = require("langchain/document_loaders/fs/epub");


const itemIndexParser = StructuredOutputParser.fromZodSchema(
    z.object({
        index: z.string().describe('item index'),
    })
);

const model = new ChatOpenAI({ 
    temperature: 0,
    modelName: 'gpt-4o-mini',
    openAIApiKey: process.env.OPENAI_API_KEY 
});

const prompt = new PromptTemplate({
    template:
        "Answer the users question as best as possible.\n{format_instructions}\n{question}",
    inputVariables: ["question"],
    partialVariables: { format_instructions: itemIndexParser.getFormatInstructions() },
});

async function search_from_quickmart(product_names = []) {
    const browser = await chromium.launch({ headless: false }); // Set headless to false to see the browser
    const context = await browser.newContext({
      geolocation: { longitude: 36.74366, latitude: -1.28472 },
      permissions: ['geolocation'],
      timezoneId: 'Africa/Nairobi'
    });


    const page = await context.newPage();
  
    await page.goto('https://www.quickmart.co.ke/', {
      waitUntil: 'domcontentloaded'
    });
  
    page.on('popup', popup => {
      console.log('Popup intercepted:', popup.url());
      popup.close(); // Prevents the popup from displaying
    });
  
  
    await page.waitForSelector('button[onclick="setContinue()"]');

    await (page.locator('button[onclick="setContinue()"]').nth(0)).click();



    const popup_input = page.getByPlaceholder('Search For Groceries...');
    let products_map = {};

    for (const product_name of product_names) {
        await popup_input.fill(product_name);
        // await popup_input.click();

        await (page.locator('button[name="btn_search"]')).click();

        await page.waitForSelector(`text=Search Results For "${product_name.slice(0,15).replaceAll(" ", "-")}`);

        // Wait for the products listing container to be available
        await page.waitForSelector('#products-listing');

        // Extract product details
        const products = await page.$$eval('#products-listing .product-listing .products', (productElements) => {
            return productElements.map((product) => {
                const titleElement = product.querySelector('.products-title');
                const priceElement = product.querySelector('.products-price-new');
                const imgElement = product.querySelector('.products-img img');
                const imageUrl = imgElement?.getAttribute('src');
        
                return {
                    title: titleElement?.textContent.trim() || null,
                    price: priceElement?.textContent.trim() || null,
                    imageUrl: imageUrl?.startsWith('http') ? imageUrl : `https://www.quickmart.co.ke${imageUrl}` || null,
                    store: 'quickmart'
                };
            });
        });

        const input = await prompt.format({ question: `From this javascript array give me the index of the item that best matches this search query "${product_name}" only return the index as a number, no any other explanations\n\n\n${JSON.stringify(products)}` });
        const item = await itemIndexParser.parse(await model.predict(input));

        if (item.index > -1 && item.index < products.length) {
            products_map[product_name] = products[item.index];
        }
    }
  
    await browser.close();

    return products_map;
}

async function search_from_naivas(product_names = []) {
    const browser = await chromium.launch({ headless: false }); // Set headless to false to see the browser
    const context = await browser.newContext({
      geolocation: { longitude: 36.74366, latitude: -1.28472 },
      permissions: ['geolocation'],
      timezoneId: 'Africa/Nairobi'
    });
    const page = await context.newPage();
  
    await page.goto('https://naivas.online/', {
      waitUntil: 'domcontentloaded'
    });
  
    page.on('popup', popup => {
      console.log('Popup intercepted:', popup.url());
      popup.close(); // Prevents the popup from displaying
    });
  
      const popup_input = page.getByPlaceholder('Search for products');

      let products_map = {};

      for (const product_name of product_names) {
        await popup_input.fill(product_name);
        await page.keyboard.press('Enter');
    
    
        await page.waitForSelector('text=Search Results Found');
    
        await page.waitForSelector('.grid.grid-cols-2.md\\:grid-cols-3.lg\\:grid-cols-4');
    
        const products = await page.$$eval('.border.border-naivas-bg', (productCards) => {
            return productCards.map(card => {
            const title = card.querySelector('.text-black-50 a')?.getAttribute('title') || '';
            const price = card.querySelector('.product-price .font-bold')?.textContent.trim() || '';
            const imageUrl = card.querySelector('img')?.getAttribute('src') || '';
        
            return {
                title,
                price,
                imageUrl,
                store: 'Naivas',
            };
            });
        });

        const input = await prompt.format({ question: `From this javascript array give me the index of the item that best matches this search query "${product_name}" only return the index as a number, no any other explanations\n\n\n${JSON.stringify(products)}` });
        const item = await itemIndexParser.parse(await model.predict(input));

        if (item.index > -1 && item.index < products.length) {
            products_map[product_name] = products[item.index];
        }
      }
  
    await browser.close();

    return products_map;
  }

  async function search_from_carrefour(product_names = []) {
    const browser = await chromium.launch({ headless: false }); // Set headless to false to see the browser
    const context = await browser.newContext({
      geolocation: { longitude: 36.74366, latitude: -1.28472 },
      permissions: ['geolocation']
    });
    const page = await context.newPage();
  
    await page.goto('https://www.carrefour.ke/mafken/en/', {
      waitUntil: 'domcontentloaded'
    });
  
    page.on('popup', popup => {
      console.log('Popup intercepted:', popup.url());
      popup.close(); // Prevents the popup from displaying
    });
  
      const popup_input = page.getByTestId('header_search__inp').nth(1);
      let products_map = {};
  
      for (const product_name of product_names) {
        await popup_input.fill(product_name);
        await page.keyboard.press('Enter');
    
    
        await page.waitForSelector(`text=Search Results For "${product_name.slice(0,15)}`);
    
        await page.waitForSelector('ul[data-testid="scrollable-list-view"]');
    
        // Extract product details
        const products = await page.$$eval(
            'ul[data-testid="scrollable-list-view"] div.css-b9nx4o',
            (productCards) => {
                return productCards.map((card) => {
                    const title = card.querySelector('a[data-testid="product_name"]')?.textContent?.trim() || null;
                    const price = card.querySelector('div[data-testid="product_price"] .css-14zpref')?.textContent?.trim() || null;
                    const imageUrl = card.querySelector('div[data-testid="product_card_image"] img')?.src || null;
    
                    return {
                        title,
                        price,
                        imageUrl,
                        store: 'Carrefour',
                    };
                });
            }
        );

        const input = await prompt.format({ question: `From this javascript array give me the index of the item that best matches this search query "${product_name}" only return the index as a number, no any other explanations\n\n\n${JSON.stringify(products)}` });
        const item = await itemIndexParser.parse(await model.predict(input));

        if (item.index > -1 && item.index < products.length) {
            products_map[product_name] = products[item.index];
        }
    }
  
    await browser.close();

    return products_map;
  }

// build the indices right heere
const pinecone = new Pinecone({
    // environment: process.env.PINECONE_ENVIRONMENT,      
    apiKey: process.env.PINECONE_API_KEY,
});

const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX);
const pineconeStore = new PineconeStore(new OpenAIEmbeddings({
    openAIApiKey: process.env.OPENAI_API_KEY,
}), { 
    pineconeIndex: pinecone.Index(process.env.PINECONE_INDEX), 
    maxConcurrency: 5
});

const parser = StructuredOutputParser.fromZodSchema(
    z.array(
        z.object({
            name: z.string().describe('Ingredient name'),
            amount: z.string().describe('Ingredient amount')
        })
    ).describe('arrays of ingredients')
);


class FoodieAutoShoppingAI {
    constructor() {
        // this will be the document ids to use in the filter
        this.llm_chat = new ChatOpenAI({
            temperature: 0.5,
            openAIApiKey: process.env.OPENAI_API_KEY,
            modelName: 'gpt-4o-mini',
            streaming: true
        });
    }

    // vectorize any document passed
    /**
     * 
     * @param {string} folder 
     */
    static async vectorize_documents(folder) {
        // vectorize it and then will be used for querying
        const { fileTypeFromFile } = await import('file-type');

        const files = await fs.readdir(folder);
        let documents = [];

        for (const file of files) {
            const absolute_file_path = path.join(folder, file);
            const file_stat = await fs.stat(absolute_file_path);

            if (file_stat.isFile()) {
                // and is a PDF then vectorize it
                const { mime } = await fileTypeFromFile(absolute_file_path);

                if (mime === 'application/pdf') {
                    const loader = new PDFLoader(new Blob([await fs.readFile(absolute_file_path)]), {
                        splitPages: true
                    });

                    documents.push(await loader.load())
                } else if (mime === 'application/zip') {
                    // vectorize the epub
                    const loader = new EPubLoader(absolute_file_path, {
                        splitChapters: true
                    });

                    documents.push(await loader.load());
                }
            }
        }

        documents = documents.flat();

        await pineconeStore.addDocuments(documents);
    }

    // take the generated recipee, get the ingerients and then search for the ingredients in our partners websites
    // get the prices and redirect them to that app if possible --> we dont want to deal with the whole setup flows
    // start with green spoon
    /**
     * 
     * @param {string} recipee 
     */
    async generate_shopping_plan(recipee) {
        // extract the ingridients
        const model = new ChatOpenAI({ 
            temperature: 0,
            modelName: 'gpt-4o-mini',
            openAIApiKey: process.env.OPENAI_API_KEY 
        });

        const prompt = new PromptTemplate({
            template:
                "Answer the users question as best as possible.\n{format_instructions}\n{question}",
            inputVariables: ["question"],
            partialVariables: { format_instructions: parser.getFormatInstructions() },
        });

        const input = await prompt.format({ question: recipee });

        const ingredients = await parser.parse(await model.predict(input));

        return {
            recipee,
            ingredients
        };
    }

    // we have a stream part and a normal part -> takes the generated recipe and tries to resolve the items from our providers
    // we also need to add images -- should we stream this
    async chat(query, on_chunk_callback, on_generation_end) {
        const vector_store = new PineconeStore(new OpenAIEmbeddings({
            openAIApiKey: process.env.OPENAI_API_KEY,
        }),{ 
            pineconeIndex: pineconeIndex, 
            maxConcurrency: 5
        });

        const retriever = vector_store.asRetriever({
            distance: 0,
            k: 10,
        })

        const questionPrompt = PromptTemplate.fromTemplate(
            `Use the following pieces of context to answer the question at the end. If you don't know the answer, just say that you don't know, don't try to make up an answer.
          ----------
          CONTEXT: {context}
          ----------
          CHAT HISTORY: {chatHistory}
          ----------
          QUESTION: {question}
          ----------
          Helpful Answer:`
        );
          
        const memory = new BufferWindowMemory({ 
            chatHistory: new ChatMessageHistory([]), 
            memoryKey: 'chat_history',
            k: 5,
            returnMessages: true
        });

        const chain = RunnableSequence.from([
            {
                question: (input) =>    input.question,
                memory: () => memory.loadMemoryVariables({}),
                
                chatHistory: (input) => {
                    return input.chatHistory ?? ""
                },

                context: async (input) => {
                    const relevantDocs = await retriever.getRelevantDocuments(input.question);
                    const serialized = formatDocumentsAsString(relevantDocs);
                    return serialized;
                },  
            },
            questionPrompt,
            this.llm_chat,
            new StringOutputParser(),
        ]);
        
        const stream = await chain.stream({ question: query });
        
        let streamedResult = "";

        for await (const chunk of stream) {
            streamedResult += chunk;
            on_chunk_callback(streamedResult);
        }

        await on_generation_end(streamedResult);
    }
}

;(async () => {
    // await FoodieAutoShoppingAI.vectorize_documents('./recipes');

    const bot = new FoodieAutoShoppingAI();

    await bot.chat("mandazi recipe", (response) => {
        console.clear();
        console.log(response);
    }, async response => {
        if (response) {
            const { recipee, ingredients } = await bot.generate_shopping_plan(response);

            let local_ingredients = [];
            // combine the two maps, dont override the values, create an array
            let product_maps = {};

            for (const shopping_experience_function of [search_from_quickmart, search_from_naivas, search_from_carrefour]) {
                const shopping_experience = await shopping_experience_function(ingredients.map(x => x.name));

                for (const ingredient of ingredients) {
                    product_maps[ingredient.name] = [
                        ...(product_maps[ingredient.name] ?? []),
                        shopping_experience[ingredient.name],
                    ];
                }
            }

            for (const ingredient of ingredients) {
                local_ingredients.push({
                    ...ingredient,
                    shopping_list: (product_maps[ingredient.name] ?? []).filter(unit => unit)
                });
            }

            local_ingredients = local_ingredients.flat();

            console.log(JSON.stringify({
                recipee,
                ingredients: local_ingredients,

                // start with the initial item selected after that, the user can swap to the correct item
                // total_cost: local_ingredients?.filter(u => u).reduce((acc, x) => {
                //     return {
                //         ...acc,
                //         total: acc.total + (+(x?.shopping_list?.price?.replace('KES', '')?.replaceAll(",","").trim() ?? 0))
                //     }
                // }, { total: 0, currency: 'KES' })
            }, null, 2))
        }
    });
})();


module.exports = { FoodieAutoShoppingAI }